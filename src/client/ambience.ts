/**
 * Each map's background sound, synthesised (no downloads): a crowd that roars
 * on a kill, rain with a ship's horn across the harbour, canyon wind, soft
 * snow wind, quarry machinery, birdsong in the forest. Crossfades on a map
 * change; quiet under the cars and guns.
 */

export type AmbienceKind = 'crowd' | 'rain' | 'wind' | 'snow' | 'machinery' | 'forest';

type Layer = { stop: () => void; react?: (strength: number) => void };

export class Ambience {
  private readonly bus: GainNode;
  private noise: AudioBuffer | null = null;
  private current: { kind: AmbienceKind; layer: Layer } | null = null;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(destination);
  }

  /** Four seconds of noise, looped by every layer (pink-ish: softer highs). */
  private noiseBuffer(): AudioBuffer {
    if (this.noise) return this.noise;
    const ctx = this.ctx;
    const length = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + white * 0.029;
        b1 = 0.985 * b1 + white * 0.032;
        b2 = 0.95 * b2 + white * 0.048;
        data[i] = (b0 + b1 + b2 + white * 0.05) * 0.9;
      }
    }
    this.noise = buffer;
    return buffer;
  }

  /** Crossfade to a map's sound (null: silence). */
  set(kind: AmbienceKind | null): void {
    if (this.current?.kind === kind) return;
    this.current?.layer.stop();
    this.current = kind ? { kind, layer: this.build(kind) } : null;
  }

  /** Something happened worth a reaction (the crowd roars at a kill). */
  react(strength: number): void {
    this.current?.layer.react?.(strength);
  }

  // ------------------------------------------------------------------ layers

  /** A looping, filtered noise source into a gain that fades in. */
  private bed(type: BiquadFilterType, frequency: number, q: number, level: number, out: AudioNode): { gain: GainNode; source: AudioBufferSourceNode } {
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer();
    source.loop = true;
    source.loopStart = Math.random() * 3;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(level, ctx.currentTime, 1.2);
    source.connect(filter).connect(gain).connect(out);
    source.start(ctx.currentTime, Math.random() * 3);
    return { gain, source };
  }

  /** A one-shot burst of filtered noise that stops itself (gusts, clanks). */
  private burst(out: AudioNode, type: BiquadFilterType, f: number, q: number, peak: number, rise: number, fall: number): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer();
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = f;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + rise);
    gain.gain.linearRampToValueAtTime(0, t + rise + fall);
    source.connect(filter).connect(gain).connect(out);
    source.start(t, Math.random() * 3);
    source.stop(t + rise + fall + 0.05);
  }

  /** A slow wobble on a gain: wind that rises and falls. */
  private wobble(param: AudioParam, rate: number, depth: number): OscillatorNode {
    const ctx = this.ctx;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    lfo.connect(amount).connect(param);
    lfo.start();
    return lfo;
  }

  private build(kind: AmbienceKind): Layer {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.connect(this.bus);
    const sources: Array<AudioScheduledSourceNode> = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let alive = true;
    /** Run `fn` again and again, a random gap between. */
    const every = (min: number, max: number, fn: () => void): void => {
      const next = (): void => {
        if (!alive) return;
        timers.push(
          setTimeout(() => {
            if (!alive) return;
            fn();
            next();
          }, (min + Math.random() * (max - min)) * 1000),
        );
      };
      next();
    };
    const stop = (): void => {
      alive = false;
      for (const t of timers) clearTimeout(t);
      out.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
      setTimeout(() => {
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            // already stopped
          }
        }
        out.disconnect();
      }, 3000);
    };
    const layer = (type: BiquadFilterType, f: number, q: number, level: number): GainNode => {
      const b = this.bed(type, f, q, level, out);
      sources.push(b.source);
      return b.gain;
    };

    switch (kind) {
      case 'crowd': {
        // A stadium murmur in two bands, breathing a little.
        const low = layer('bandpass', 420, 0.7, 0.12);
        layer('bandpass', 1300, 1.1, 0.05);
        sources.push(this.wobble(low.gain, 0.13, 0.03));
        const roar = layer('bandpass', 900, 0.6, 0);
        const cheer = layer('bandpass', 2300, 1.4, 0);
        return {
          stop,
          react: (strength) => {
            const t = ctx.currentTime;
            for (const [g, peak] of [
              [roar, 0.42 * strength],
              [cheer, 0.12 * strength],
            ] as const) {
              g.gain.cancelScheduledValues(t);
              g.gain.setTargetAtTime(peak, t, 0.15);
              g.gain.setTargetAtTime(0, t + 0.9, 1.1);
            }
          },
        };
      }
      case 'rain': {
        layer('highpass', 1800, 0.5, 0.16);
        layer('lowpass', 320, 0.7, 0.07);
        // A ship's horn across the harbour, now and then.
        every(40, 90, () => {
          const t = ctx.currentTime;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = 380;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.06, t + 0.6);
          g.gain.setValueAtTime(0.06, t + 2.2);
          g.gain.linearRampToValueAtTime(0, t + 3.4);
          lp.connect(g).connect(out);
          for (const f of [98, 147]) {
            const o = ctx.createOscillator();
            o.type = 'sawtooth';
            o.frequency.value = f;
            o.connect(lp);
            o.start(t);
            o.stop(t + 3.6);
          }
        });
        return { stop };
      }
      case 'wind':
      case 'snow': {
        const snow = kind === 'snow';
        const w = layer('lowpass', snow ? 900 : 520, 0.8, snow ? 0.07 : 0.13);
        sources.push(this.wobble(w.gain, snow ? 0.06 : 0.09, snow ? 0.035 : 0.07));
        // Gusts: a whistle that rises and falls.
        every(snow ? 14 : 8, snow ? 28 : 18, () => {
          this.burst(out, 'bandpass', 700 + Math.random() * 600, 3, snow ? 0.03 : 0.06, 1.6, 2.6);
        });
        return { stop };
      }
      case 'machinery': {
        // The crusher's hum across the pit, a little wind, the odd clank.
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 240;
        const hum = ctx.createGain();
        hum.gain.value = 0;
        hum.gain.setTargetAtTime(0.05, ctx.currentTime, 1.5);
        lp.connect(hum).connect(out);
        for (const [type, f] of [
          ['sine', 55],
          ['square', 110],
        ] as const) {
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.value = f;
          o.connect(lp);
          o.start();
          sources.push(o);
        }
        layer('lowpass', 600, 0.7, 0.05);
        every(6, 14, () => {
          this.burst(out, 'bandpass', 1800 + Math.random() * 1200, 6, 0.05, 0.005, 0.25);
        });
        return { stop };
      }
      case 'forest': {
        const w = layer('bandpass', 700, 0.6, 0.05);
        sources.push(this.wobble(w.gain, 0.07, 0.025));
        // Birds: short chirps, left and right.
        every(1.5, 5, () => {
          const t = ctx.currentTime;
          const pan = ctx.createStereoPanner();
          pan.pan.value = Math.random() * 1.6 - 0.8;
          pan.connect(out);
          const base = 2400 + Math.random() * 1400;
          const notes = 2 + Math.floor(Math.random() * 3);
          for (let n = 0; n < notes; n++) {
            const o = ctx.createOscillator();
            o.type = 'sine';
            const start = t + n * 0.12;
            o.frequency.setValueAtTime(base, start);
            o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), start + 0.07);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(0.025, start + 0.015);
            g.gain.exponentialRampToValueAtTime(0.0005, start + 0.09);
            o.connect(g).connect(pan);
            o.start(start);
            o.stop(start + 0.1);
          }
        });
        return { stop };
      }
    }
  }
}
