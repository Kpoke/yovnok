/**
 * Several matches at once, in one process.
 *
 * A Room is one match. With a single room, anyone pressing PLAY while it was
 * mid-match was turned away ("match full") — a dead end for a public game. The
 * manager keeps as many rooms as there are groups of players, and places each
 * player when they press PLAY:
 *
 *   1. a car this browser left mid-match is still held → back to that room;
 *   2. otherwise a room that is not mid-match and has a seat — the one closest
 *      to starting first, so groups fill up rather than scatter;
 *   3. otherwise a new room.
 *
 * Routing happens on `hello`, not on connect: the page connects as it opens and
 * may sit on the title for minutes, and the room it would have been given may
 * be mid-match by the time PLAY is pressed. Until then the socket belongs to
 * the manager, which answers the title's `held?` by asking every room.
 *
 * Extra rooms close once idle (no humans, no held car). There is always one.
 */

import type { WebSocket } from 'ws';
import { Room } from './room';
import { record } from './stats';

/** Upper bound on rooms in one process (each is a simulation at 60 Hz). */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 8);
/** A connected page that never presses PLAY is closed after this long. */
const TITLE_IDLE_MS = Number(process.env.TITLE_IDLE_MS ?? 30 * 60 * 1000);
/** Keepalive for sockets still on the title (proxies drop silent sockets). */
const PING_MS = 25_000;

type Pending = { socket: WebSocket; since: number; alive: boolean };

export class RoomManager {
  private readonly rooms: Room[] = [];
  private readonly pending = new Set<Pending>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.open();
    this.timer = setInterval(() => this.sweep(), 10_000);
  }

  /** A new connection: held here until it says `hello`. */
  /** @param country two-letter country (Cloudflare), for anonymous statistics */
  accept(socket: WebSocket, country: string | null = null): void {
    const entry: Pending = { socket, since: Date.now(), alive: true };
    this.pending.add(entry);

    const onMessage = (data: unknown): void => {
      let msg: { t?: unknown; token?: unknown; client?: { input?: unknown; quality?: unknown } };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.t === 'held?') {
        const token = typeof msg.token === 'string' ? msg.token : '';
        const seconds = token ? Math.max(0, ...this.rooms.map((r) => r.heldSecondsFor(token))) : 0;
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'held', seconds }));
        // (Visits are counted by /config.json, which the page fetches through
        // Cloudflare; the socket itself may come straight to the server.)
        return;
      }
      if (msg.t !== 'hello') return; // nothing else means anything before joining

      const token = typeof msg.token === 'string' ? msg.token : '';
      const room = this.place(token);
      cleanup();
      if (!room) {
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'reject', reason: 'server full' }));
        console.log('[rooms] rejected a player: every room is mid-match and the room cap is reached');
        return;
      }
      const input = ['mouse', 'gamepad', 'touch'].includes(String(msg.client?.input)) ? String(msg.client?.input) : null;
      const quality = ['low', 'medium', 'high'].includes(String(msg.client?.quality)) ? String(msg.client?.quality) : null;
      record('join', token || null, country, { input, quality });
      room.addClient(socket, [data]);
    };
    const onPong = (): void => {
      entry.alive = true;
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('pong', onPong);
      socket.off('close', cleanup);
      this.pending.delete(entry);
    };
    socket.on('message', onMessage);
    socket.on('pong', onPong);
    socket.on('close', cleanup);
  }

  /** Which room a player pressing PLAY goes to; null when full. */
  private place(token: string): Room | null {
    if (token) {
      const holding = this.rooms.find((r) => r.heldSecondsFor(token) > 0);
      if (holding) return holding;
    }
    const joinable = this.rooms.filter((r) => r.joinable);
    // Closest to starting first, then the fullest: players gather, not scatter.
    joinable.sort((a, b) => Number(b.startingSoon) - Number(a.startingSoon) || b.playerCount - a.playerCount);
    if (joinable[0]) return joinable[0];
    if (this.rooms.length >= MAX_ROOMS) return null;
    return this.open();
  }

  private open(): Room {
    const room = new Room();
    room.start();
    this.rooms.push(room);
    console.log(`[rooms] opened room ${this.rooms.length} (${this.rooms.length} running)`);
    return room;
  }

  /** Close idle extra rooms; keep title sockets alive; drop abandoned ones. */
  private sweep(): void {
    for (let i = this.rooms.length - 1; i > 0; i--) {
      const room = this.rooms[i];
      if (!room.idle) continue;
      room.stop();
      this.rooms.splice(i, 1);
      console.log(`[rooms] closed an idle room (${this.rooms.length} running)`);
    }
    const now = Date.now();
    for (const entry of this.pending) {
      if (now - entry.since > TITLE_IDLE_MS || !entry.alive) {
        entry.socket.terminate();
        this.pending.delete(entry);
        continue;
      }
      if (now - entry.since > PING_MS) {
        entry.alive = false;
        entry.socket.ping();
      }
    }
  }

  /** Totals across rooms, for /healthz. No identities, no positions. */
  health(): { rooms: number; players: number; waiting: number; phases: string[] } {
    return {
      rooms: this.rooms.length,
      players: this.rooms.reduce((n, r) => n + r.playerCount, 0),
      waiting: this.pending.size,
      phases: this.rooms.map((r) => r.health().phase),
    };
  }

  stop(): void {
    clearInterval(this.timer);
    for (const room of this.rooms) room.stop();
  }
}
