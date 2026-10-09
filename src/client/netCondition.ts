/**
 * Network conditioner — simulated latency, jitter and packet loss.
 *
 * Netcode cannot be validated on localhost. Everything is 1 ms and perfectly
 * ordered, so prediction, reconciliation, the input buffer and the interpolation
 * delay are all being tested against a network that does not exist. Every
 * iteration so far has been "it works on localhost", which proves almost
 * nothing about how it behaves for someone on hotel wifi.
 *
 * Wrapping the socket lets us actually reproduce the conditions the netcode is
 * designed for, and check that it degrades gracefully rather than lying.
 *
 * Enable from the URL, e.g.:
 *
 *   http://localhost:5173/?lag=120&jitter=40&loss=0.05
 *
 *   lag     one-way delay in ms. RTT is roughly 2x this.
 *   jitter  +/- random variance applied to each message, in ms.
 *   loss    fraction of messages dropped, 0..1.
 *
 * Loss here drops messages outright, which is closer to UDP than to the TCP
 * socket underneath. That is deliberate: it is the model battle royale will use
 * over WebRTC data channels (§10.5), and it is the harsher case our input queue
 * and snapshot interpolation have to survive.
 */

export type NetConditions = {
  /** One-way delay in ms. */
  lag: number;
  /** Random +/- variance added to each message, in ms. */
  jitter: number;
  /** Fraction of messages dropped, 0..1. */
  loss: number;
};

export const NO_CONDITIONS: NetConditions = { lag: 0, jitter: 0, loss: 0 };

export function conditionsAreActive(c: NetConditions): boolean {
  return c.lag > 0 || c.jitter > 0 || c.loss > 0;
}

export function readConditions(search: string): NetConditions {
  const params = new URLSearchParams(search);
  const num = (key: string, fallback: number): number => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    lag: Math.max(0, num('lag', 0)),
    jitter: Math.max(0, num('jitter', 0)),
    loss: Math.min(1, Math.max(0, num('loss', 0))),
  };
}

/**
 * The shape the client uses of a socket. Kept structural so the real WebSocket
 * and the conditioned one are interchangeable.
 */
export type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

export class ConditionedSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  private inner: WebSocket;
  private conditions: NetConditions;
  /**
   * Monotonic release times, per direction.
   *
   * The transport underneath is TCP, so messages CANNOT arrive out of order.
   * Naively giving every message a random `setTimeout` would reorder them, which
   * would make the server (correctly) reject out-of-order input and would be
   * testing a network that cannot exist. Holding the release time monotonic
   * turns jitter into accumulated head-of-line delay instead, which is what
   * actually happens on a jittery TCP connection.
   */
  private lastOutboundRelease = 0;
  private lastInboundRelease = 0;

  constructor(url: string, conditions: NetConditions) {
    this.conditions = conditions;
    this.inner = new WebSocket(url);

    this.inner.onopen = () => {
      this.readyState = 1;
      this.onopen?.();
    };
    this.inner.onclose = () => {
      this.readyState = 3;
      this.onclose?.();
    };
    this.inner.onerror = () => this.onerror?.();
    this.inner.onmessage = (event: MessageEvent) => {
      if (this.shouldDrop()) return;
      this.deliverInbound(String(event.data));
    };
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    if (this.shouldDrop()) return;

    if (!conditionsAreActive(this.conditions)) {
      this.inner.send(data);
      return;
    }

    const now = performance.now();
    if (this.lastOutboundRelease === 0) this.lastOutboundRelease = now;
    const release = Math.max(now + this.nextDelay(), this.lastOutboundRelease);
    this.lastOutboundRelease = release;

    setTimeout(
      () => {
        if (this.inner.readyState === 1) this.inner.send(data);
      },
      Math.max(0, release - now),
    );
  }

  close(): void {
    this.inner.close();
  }

  /** True when any conditioning is active — used to warn in the HUD. */
  get conditioned(): boolean {
    return conditionsAreActive(this.conditions);
  }

  private deliverInbound(data: string): void {
    if (!conditionsAreActive(this.conditions)) {
      this.onmessage?.({ data });
      return;
    }

    const now = performance.now();
    if (this.lastInboundRelease === 0) this.lastInboundRelease = now;
    const release = Math.max(now + this.nextDelay(), this.lastInboundRelease);
    this.lastInboundRelease = release;

    setTimeout(() => this.onmessage?.({ data }), Math.max(0, release - now));
  }

  private nextDelay(): number {
    const { lag, jitter } = this.conditions;
    if (lag <= 0 && jitter <= 0) return 0;
    // Symmetric jitter: real networks run early as often as late.
    const wobble = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
    return Math.max(0, lag + wobble);
  }

  private shouldDrop(): boolean {
    return this.conditions.loss > 0 && Math.random() < this.conditions.loss;
  }
}
