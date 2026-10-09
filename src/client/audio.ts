/**
 * Game audio (DESIGN.md §8, M9).
 *
 * Entirely PROCEDURAL — no asset files. Every sound is synthesised from
 * oscillators and a noise buffer, which keeps the build asset-free and makes the
 * pitch of the engine and the length of a burst into tuning numbers rather than
 * audio files.
 *
 * Audio is treated as a gameplay system, not decoration (§8): you hear an enemy
 * engine approaching from behind, locate gunfire by direction — remote sounds go
 * through a positional panner, your own are centred — and the closing zone gets a
 * nagging tone. That is why the listener is driven from the CAMERA every frame.
 *
 * Browsers refuse to start audio without a user gesture, so nothing is created
 * until `init()` is called from the JOIN click.
 */

import { FEEL } from '../shared/config';
import type { WeaponId } from '../shared/weapons';

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /** Recorded samples (public/audio/sfx/, credited in ASSETS.md), by name. */
  private samples = new Map<string, AudioBuffer>();
  /** Send to the outdoor echo: what makes a gun sound big rather than close. */
  private reverbSend: GainNode | null = null;

  private engine: {
    osc1: OscillatorNode;
    osc2: OscillatorNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    /** Intake/exhaust roar: band-passed noise that tracks the revs. */
    roar: BiquadFilterNode;
    roarGain: GainNode;
    /** Tyre squeal (hard ground, sliding), gravel crunch (dirt), wind (speed). */
    squeal: GainNode;
    gravel: GainNode;
    wind: GainNode;
  } | null = null;
  /** Was boost engaged last frame — its rising edge gets a whoosh. */
  private wasBoosting = false;

  /**
   * The zone alarm. `alarm` is the on/off envelope; the tremolo lives UPSTREAM
   * of it, so with the alarm at 0 nothing gets through.
   */
  private zone: { osc: OscillatorNode; alarm: GainNode } | null = null;

  private enabled = true;
  /** Global rate limit on gunfire, so a firefight does not stack 30 voices. */
  private nextGunAt = 0;
  private nextHitAt = 0;
  private nextClangAt = 0;

  get ready(): boolean {
    return this.ctx !== null && this.enabled;
  }

  /** Diagnostics: the browser's audio state, for probes. */
  get contextState(): string {
    return this.ctx?.state ?? 'none';
  }

  /** Diagnostics: the zone alarm's current gain. Must be 0 when not outside. */
  get zoneLevel(): number {
    return this.zone?.alarm.gain.value ?? 0;
  }

  /** Create the graph. Must be called from a user gesture (a click). */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.65;
    this.master.connect(ctx.destination);

    // Effects run through a compressor: it lets the loud layers (shots,
    // explosions) be loud without clipping, and gives them punch.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 6;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    compressor.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1.15;
    this.sfx.connect(compressor);

    // Outdoor echo: a generated impulse — a few early slap-backs off "walls",
    // then a 1.6 s noise decay. Sent from guns and explosions only.
    const convolver = ctx.createConvolver();
    convolver.buffer = outdoorImpulse(ctx);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(convolver).connect(compressor);
    void this.loadSamples(ctx);

    // One noise buffer, reused by every percussive sound.
    const length = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    this.startEngine();
    this.startZoneTone();
    void ctx.resume();
  }

  private async loadSamples(ctx: AudioContext): Promise<void> {
    await Promise.all(
      SAMPLES.map(async (name) => {
        try {
          const response = await fetch(`/audio/sfx/${name}.ogg`);
          this.samples.set(name, await ctx.decodeAudioData(await response.arrayBuffer()));
        } catch {
          // A missing sample leaves the synthesised layers; not worth failing over.
        }
      }),
    );
  }

  /**
   * Play a recorded sample. `rate` shifts pitch (slight random variation keeps
   * rapid fire from sounding like one clip on repeat); `wet` is the echo send.
   */
  private sample(
    name: string,
    x: number,
    y: number,
    z: number,
    local: boolean,
    gain: number,
    rate = 1,
    wet = 0,
  ): void {
    const ctx = this.ctx;
    const buffer = this.samples.get(name);
    if (!ctx || !buffer) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const level = ctx.createGain();
    level.gain.value = gain;
    src.connect(level);
    this.route(level, x, y, z, local, now, wet);
    src.start(now);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0.65 : 0, this.ctx.currentTime, 0.05);
    }
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  // ------------------------------------------------------------------ engine

  private startEngine(): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.noise) return;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 48;
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 74;
    const sub = ctx.createGain();
    sub.gain.value = 0.5;
    osc1.connect(filter);
    osc2.connect(sub).connect(filter);
    filter.connect(gain).connect(this.sfx);
    osc1.start();
    osc2.start();

    // Looping noise layers, each with its own filter and level.
    const loop = (type: BiquadFilterType, frequency: number, q: number): [BiquadFilterNode, GainNode] => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      // Start each loop at a different point so the layers do not phase.
      src.start(0, Math.random() * (this.noise?.duration ?? 1));
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.sfx!);
      return [f, g];
    };
    const [roar, roarGain] = loop('bandpass', 200, 1.2);
    const [, squeal] = loop('bandpass', 1500, 7);
    const [, gravel] = loop('lowpass', 700, 0.7);
    const [, wind] = loop('highpass', 900, 0.5);
    this.engine = { osc1, osc2, filter, gain, roar, roarGain, squeal, gravel, wind };
  }

  /**
   * Engine and road, every frame, for our own car (Phase 8).
   *
   * The engine runs through GEARS: within each gear the revs climb with speed,
   * and at the gear's top they drop into the next. That rise-and-drop is the
   * single strongest "this is accelerating" cue a car sound has — a note that
   * simply rises with speed reads as a siren. Off throttle the load (filter,
   * roar) falls away, so lifting sounds like lifting.
   */
  updateEngine(
    speed: number,
    throttle: number,
    dt: number,
    road: { slip: number; ground: 'dirt' | 'hard'; onGround: boolean; boosting: boolean; active?: boolean } = {
      slip: 0,
      ground: 'hard',
      onGround: true,
      boosting: false,
    },
  ): void {
    const ctx = this.ctx;
    const engine = this.engine;
    if (!ctx || !engine) return;
    const now = ctx.currentTime;
    const v = Math.abs(speed);
    const on = this.enabled && road.active !== false ? 1 : 0;

    // Which gear, and how far through it.
    const gears = FEEL.sound.gears;
    let lo = 0;
    let gear = gears.length - 1;
    for (let i = 0; i < gears.length; i++) {
      if (v < gears[i]) {
        gear = i;
        break;
      }
      lo = gears[i];
    }
    const hi = gears[gear];
    const through = Math.min(1, Math.max(0, (v - lo) / Math.max(1, hi - lo)));
    // Revs as a fraction of the rev range: a shift lands about 40% down.
    const rpm = 0.3 + 0.7 * through + (road.onGround ? 0 : 0.25 * Math.max(0, throttle));
    const pushing = Math.max(0, throttle) + (road.boosting ? 0.6 : 0);
    const load = Math.min(1.3, 0.25 + pushing * 0.75);

    const rev = 42 + rpm * 120;
    engine.osc1.frequency.setTargetAtTime(rev, now, 0.05);
    engine.osc2.frequency.setTargetAtTime(rev * 1.5, now, 0.05);
    engine.filter.frequency.setTargetAtTime(350 + load * 1500 + rpm * 900, now, 0.08);
    engine.gain.gain.setTargetAtTime(on * (0.035 + load * 0.09 + rpm * 0.05), now, 0.1);
    engine.roar.frequency.setTargetAtTime(rev * 2.2, now, 0.05);
    engine.roarGain.gain.setTargetAtTime(on * pushing * (0.05 + rpm * 0.12), now, 0.1);

    // Road: squeal on hard ground while sliding, crunch on dirt, wind at speed.
    const sliding = road.onGround && road.ground === 'hard' ? Math.min(1, Math.max(0, (Math.abs(road.slip) - 3.5) / 7)) : 0;
    engine.squeal.gain.setTargetAtTime(on * sliding * 0.16, now, 0.06);
    const crunch = road.onGround && road.ground === 'dirt' ? Math.min(1, v / 30) : 0;
    engine.gravel.gain.setTargetAtTime(on * crunch * 0.13, now, 0.12);
    const windLevel = Math.min(1, (v / 50) ** 2);
    engine.wind.gain.setTargetAtTime(on * windLevel * 0.09, now, 0.25);

    // Boost: a whoosh on the rising edge.
    if (road.boosting && !this.wasBoosting && this.enabled && this.noise && this.sfx) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 0.9;
      f.frequency.setValueAtTime(400, now);
      f.frequency.exponentialRampToValueAtTime(2400, now + 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.35, now + 0.08);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
      src.connect(f).connect(g).connect(this.sfx);
      src.start(now);
      src.stop(now + 0.75);
    }
    this.wasBoosting = road.boosting;
    void dt;
  }

  // ------------------------------------------------------------------- shots

  /**
   * A gunshot. Remote shots are positioned; our own are centred and louder.
   * `weapon` picks the voice: the .50s are a heavy thump with a crack on top, the
   * RPG a launch whoosh; anything else keeps the original rifle snap.
   */
  shot(x: number, y: number, z: number, local: boolean, weapon: WeaponId = 'rifle'): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.sfx || !this.enabled) return;
    const now = ctx.currentTime;
    if (weapon === 'rocket' || weapon === 'launcher') {
      this.launch(x, y, z, local, now);
      return;
    }
    if (weapon === 'mg') {
      if (now < this.nextGunAt) return;
      this.nextGunAt = now + 0.02;
      // The recorded report, slightly re-pitched each round, with a touch of
      // echo; the synthesised crack and sub-thump below add bite and weight.
      this.sample('mg-shot', x, y, z, local, local ? 0.85 : 0.6, 0.93 + Math.random() * 0.12, local ? 0.18 : 0.3);
      // Crack: bright, very short noise.
      const crack = ctx.createBufferSource();
      crack.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.value = local ? 1800 : 1200;
      hp.Q.value = 0.9;
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(local ? 0.42 : 0.26, now);
      crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      crack.connect(hp).connect(crackGain);
      this.route(crackGain, x, y, z, local, now);
      crack.start(now);
      crack.stop(now + 0.09);
      // Thump: a dropping sine for the weight of a .50 cal.
      const thump = ctx.createOscillator();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(140, now);
      thump.frequency.exponentialRampToValueAtTime(55, now + 0.08);
      const thumpGain = ctx.createGain();
      thumpGain.gain.setValueAtTime(local ? 0.75 : 0.35, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
      thump.connect(thumpGain);
      this.route(thumpGain, x, y, z, local, now);
      thump.start(now);
      thump.stop(now + 0.12);
      return;
    }
    // Cap the global rate so a 16-car brawl cannot swamp the mixer.
    if (now < this.nextGunAt) return;
    this.nextGunAt = now + 0.025;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = local ? 1400 : 950;
    band.Q.value = 0.7;
    const gain = ctx.createGain();
    const peak = local ? 0.5 : 0.32;
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);

    src.connect(band).connect(gain);
    this.route(gain, x, y, z, local, now);
    src.start(now);
    src.stop(now + 0.16);
  }

  /** An RPG leaving the tube: a hard pop and a rushing whoosh that fades. */
  private launch(x: number, y: number, z: number, local: boolean, now: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    this.sample('rpg-launch', x, y, z, local, local ? 1 : 0.75, 0.96 + Math.random() * 0.08, 0.4);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const sweep = ctx.createBiquadFilter();
    sweep.type = 'bandpass';
    sweep.Q.value = 0.6;
    sweep.frequency.setValueAtTime(400, now);
    sweep.frequency.exponentialRampToValueAtTime(2400, now + 0.12);
    sweep.frequency.exponentialRampToValueAtTime(700, now + 0.7);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(local ? 0.7 : 0.45, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    src.connect(sweep).connect(gain);
    this.route(gain, x, y, z, local, now);
    src.start(now);
    src.stop(now + 0.85);

    const pop = ctx.createOscillator();
    pop.type = 'sine';
    pop.frequency.setValueAtTime(110, now);
    pop.frequency.exponentialRampToValueAtTime(40, now + 0.15);
    const popGain = ctx.createGain();
    popGain.gain.setValueAtTime(local ? 0.6 : 0.35, now);
    popGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    pop.connect(popGain);
    this.route(popGain, x, y, z, local, now);
    pop.start(now);
    pop.stop(now + 0.22);
  }

  // --------------------------------------------------------------- explosions

  explosion(x: number, y: number, z: number, local: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.sfx || !this.enabled) return;
    const now = ctx.currentTime;
    // Recorded body (bassy, close) and tail (a real cannon's roll), heavily
    // sent to the echo so it carries across the arena.
    this.sample('explosion-body', x, y, z, local, 1.1, 0.9 + Math.random() * 0.15, 0.55);
    this.sample('explosion-tail', x, y, z, local, 0.8, 0.85 + Math.random() * 0.15, 0.7);

    // Body: a filtered noise burst that decays over a second.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(1200, now);
    low.frequency.exponentialRampToValueAtTime(180, now + 0.9);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
    src.connect(low).connect(gain);
    this.route(gain, x, y, z, local, now);
    src.start(now);
    src.stop(now + 1.2);

    // Sub: a dropping sine that gives it weight.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90, now);
    sub.frequency.exponentialRampToValueAtTime(28, now + 0.5);
    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.7, now);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
    sub.connect(subGain);
    this.route(subGain, x, y, z, local, now);
    sub.start(now);
    sub.stop(now + 0.8);
  }

  // ------------------------------------------------------------------ impacts

  /**
   * Our own car taking a hit: armour ringing plus a low thud, non-positional
   * (it is happening to us), scaled by how much hull it cost. Loud on purpose:
   * being shot must never be something you only notice on the HUD.
   */
  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.sfx || !this.enabled) return;
    const now = ctx.currentTime;
    if (now >= this.nextClangAt) {
      this.nextClangAt = now + 0.07;
      this.sample('hull-clang', 0, 0, 0, true, Math.min(1, 0.45 + strength * 2), 0.85 + Math.random() * 0.3);
      this.sample('hit-thud', 0, 0, 0, true, Math.min(1, 0.5 + strength * 2), 0.8 + Math.random() * 0.2);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 320;
    const gain = ctx.createGain();
    const peak = Math.min(0.6, 0.15 + strength * 0.5);
    gain.gain.setValueAtTime(peak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    src.connect(low).connect(gain).connect(this.sfx);
    src.start(now);
    src.stop(now + 0.25);
  }

  /**
   * Our rounds landing on another car (server-confirmed): rounds striking
   * armour — a metallic clink, varied each time, over a dull thud. `heavy` is a
   * rocket: the big clang. Non-positional: it is feedback to the shooter.
   */
  hitConfirm(heavy = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.enabled) return;
    const now = ctx.currentTime;
    if (!heavy && now < this.nextHitAt) return;
    this.nextHitAt = now + 0.045;
    if (heavy) {
      this.sample('hull-clang', 0, 0, 0, true, 0.9, 0.7 + Math.random() * 0.1);
      this.sample('hit-thud', 0, 0, 0, true, 0.9, 0.7);
    } else {
      const clink = `hit-metal-${1 + Math.floor(Math.random() * 3)}`;
      this.sample(clink, 0, 0, 0, true, 0.55, 0.85 + Math.random() * 0.35);
      this.sample('hit-thud', 0, 0, 0, true, 0.35, 1 + Math.random() * 0.3);
    }
    this.hitmarker();
  }

  /** A confirmed hit on someone else: a short bright tick under the impact. */
  hitmarker(): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.enabled) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1500, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.06);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(gain).connect(this.sfx);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  // --------------------------------------------------------------------- zone

  private startZoneTone(): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;

    // On/off envelope. Starts at exactly 0, so the alarm is silent until it is
    // asked for. Everything that shapes the tone sits BEFORE this gain.
    const alarm = ctx.createGain();
    alarm.gain.value = 0;

    // Tremolo is a MULTIPLIER here, not an added offset: the LFO swings a gain
    // whose base is 1, between 0.4 and 1.6. (The first version connected the LFO
    // straight to the alarm's gain, which with a base of 0 swung it NEGATIVE to
    // positive — so the alarm was audible half of every cycle forever, from the
    // moment audio started. That was the constant beeping.)
    const tremolo = ctx.createGain();
    tremolo.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 3;
    const depth = ctx.createGain();
    depth.gain.value = 0.6;
    lfo.connect(depth).connect(tremolo.gain);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 190;
    osc.connect(tremolo).connect(alarm).connect(this.sfx);

    osc.start();
    lfo.start();
    this.zone = { osc, alarm };
  }

  /** The nag when you are outside the safe circle. Fades in and out, silent off. */
  setZoneAlarm(on: boolean): void {
    const ctx = this.ctx;
    const zone = this.zone;
    if (!ctx || !zone) return;
    zone.alarm.gain.setTargetAtTime(on && this.enabled ? 0.05 : 0, ctx.currentTime, 0.15);
  }

  // ------------------------------------------------------------------ listener

  /** Point the listener where the camera is, every frame. */
  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const now = ctx.currentTime;
    const set = (param: AudioParam | undefined, value: number): void => {
      if (param) param.setTargetAtTime(value, now, 0.02);
    };
    if (l.positionX) {
      set(l.positionX, px);
      set(l.positionY, py);
      set(l.positionZ, pz);
      set(l.forwardX, fx);
      set(l.forwardY, fy);
      set(l.forwardZ, fz);
      set(l.upX, 0);
      set(l.upY, 1);
      set(l.upZ, 0);
    } else {
      // Older Safari: the deprecated setters.
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (l as unknown as { setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void }).setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /**
   * Send a node to the bus, positioned when it is happening elsewhere. `wet`
   * also sends that share to the outdoor echo.
   */
  private route(
    node: AudioNode,
    x: number,
    y: number,
    z: number,
    local: boolean,
    now: number,
    wet = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    if (wet > 0 && this.reverbSend) {
      const send = ctx.createGain();
      send.gain.value = wet;
      node.connect(send).connect(this.reverbSend);
    }
    if (local) {
      node.connect(this.sfx);
      return;
    }
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower'; // cheaper than HRTF, fine for direction
    panner.distanceModel = 'inverse';
    panner.refDistance = 8;
    panner.maxDistance = 320;
    panner.rolloffFactor = 1.1;
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
    node.connect(panner).connect(this.sfx);
    void now;
  }
}

/** Recorded samples loaded from public/audio/sfx/ (see ASSETS.md for credits). */
const SAMPLES = [
  'mg-shot',
  'rpg-launch',
  'explosion-body',
  'explosion-tail',
  'hit-metal-1',
  'hit-metal-2',
  'hit-metal-3',
  'hit-thud',
  'hull-clang',
];

/**
 * A generated outdoor impulse response: a few distinct early reflections (as
 * off nearby walls and stands), then a diffuse noise tail decaying over ~1.6 s.
 * Stereo, slightly different per channel, so the echo has width.
 */
function outdoorImpulse(ctx: AudioContext): AudioBuffer {
  const seconds = 1.8;
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / ctx.sampleRate;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / seconds, 3) * 0.35;
    }
    for (const [delay, level] of [[0.045, 0.6], [0.11, 0.45], [0.19, 0.3], [0.32, 0.2]]) {
      const at = Math.floor((delay + channel * 0.007) * ctx.sampleRate);
      if (at < length) data[at] += level;
    }
  }
  return buffer;
}
