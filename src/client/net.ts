/**
 * Client networking: prediction, reconciliation, interpolation and aim.
 *
 * DESIGN.md §13.4. The M4 change is that the simulated entity is a CREW vehicle,
 * not a player's own car, which splits the client in two:
 *
 *   DRIVER  predicts the crew vehicle from local input, exactly as before. They
 *           are the only one whose input moves it, so only they can.
 *   GUNNER  rides it. They cannot predict an input they do not have, so the
 *           vehicle arrives from snapshots and is interpolated like any other.
 *           Their own contribution is AIM, clamped to their window's arc.
 *
 * Reconciliation is unchanged in principle: snap to the server's state, replay
 * inputs the server has not applied, and decay the difference rather than
 * snapping, because vehicles are large and the camera is bolted to one.
 */

import {
  DEFAULT_VEHICLE_CLASS,
  NET,
  TICK,
  VEHICLE_CLASSES,
  type VehicleClassId,
} from '../shared/config';
import { SPAWNS } from '../shared/arena';
import {
  clampToArc,
  seatById,
  type SeatId,
  mountedLoadout,
  type MountedWeapon,
} from '../shared/crews';
import {
  createVehicle,
  resetVehicle,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../shared/vehicle';
import { clamp, wrapAngle } from '../shared/math';
import { copyComponents, type Components } from '../shared/components';
import {
  aimAnglesAt,
  aimMountedWeapon,
  muzzleWorld,
  relativeAim,
  vehiclePointWorld,
  resolveAimPoint,
  resolveHitscan,
  type CombatMember,
  type CombatVehicle,
} from '../shared/combat';
import { COMBAT } from '../shared/config';
import { DEFAULT_LOADOUT, weaponInSlot, WEAPONS, type WeaponId } from '../shared/weapons';
import { DEFAULT_LOOK, packLook } from '../shared/cosmetics';
import type {
  BoardRow,
  ClientMessage,
  InputCmd,
  KillEvent,
  MemberSnapshot,
  ProjectileSnapshot,
  RepairCrateSnapshot,
  ShotEvent,
  VehicleSnapshot,
} from '../shared/protocol';
import type { ServerMessage } from '../shared/protocol';
import type { MatchSnapshot } from '../shared/match';
import type { ZoneState } from '../shared/zone';
import {
  ConditionedSocket,
  conditionsAreActive,
  NO_CONDITIONS,
  type NetConditions,
} from './netCondition';

type SnapshotMessage = Extract<ServerMessage, { t: 'snap' }>;
type BufferedSnapshot = {
  time: number;
  vehicles: Map<number, VehicleSnapshot>;
  members: Map<number, MemberSnapshot>;
};

const MAX_PENDING_INPUTS = 120;
/** How often a gunner's aim is broadcast. Faster than snapshots, cheaper than input. */
const AIM_SEND_HZ = 20;

/** Match state before the first snapshot arrives: nothing has happened yet. */
const EMPTY_MATCH: MatchSnapshot = {
  mode: 'duel',
  phase: 'lobby',
  remainingMs: 0,
  scores: [0, 0],
  winner: null,
  reason: null,
  suddenDeath: false,
  alive: 2,
  ready: 0,
  players: 0,
  roster: 0,
};

/** Vehicle class from the URL, e.g. `?car=coupe`. Dev-only; the room decides. */
export function readVehicleClass(search: string): VehicleClassId {
  const requested = new URLSearchParams(search).get('car');
  // The solo truck is the MVP's car, so it is what the title screen shows. The
  // server decides the real class on join (and only honours coupe/suv requests).
  return requested && requested in VEHICLE_CLASSES ? (requested as VehicleClassId) : 'solo';
}

/** Optional crew/seat request, honoured only when the server allows dev assignment. */
export function readCrewRequest(search: string): { crew?: number; seat?: SeatId } {
  const params = new URLSearchParams(search);
  const crew = params.get('crew');
  const seat = params.get('seat');
  return {
    crew: crew !== null && Number.isFinite(Number(crew)) ? Number(crew) : undefined,
    seat: seat ? (seat as SeatId) : undefined,
  };
}

export class NetClient {
  /** The authoritative class of the crew we ended up in. */
  vehicleClass: VehicleClassId;
  /** The vehicle we are riding in — predicted if we drive it, interpolated if not. */
  readonly local: VehicleState;
  /** Other crews' vehicles, keyed by crew id. */
  readonly remotes = new Map<number, VehicleState>();
  /**
   * Packed cosmetic look per crew (M12). Kept beside `remotes` rather than in
   * the simulated state, because the simulation must never read a cosmetic.
   */
  readonly remoteLooks = new Map<number, number>();
  /** Everyone in the match, keyed by player id. */
  readonly members = new Map<number, MemberSnapshot>();

  /**
   * Weapons we hold, in slot order. Derived from our SEAT, not chosen: a seat
   * with car-mounted guns defines the loadout (the car is the weapon), and a
   * window gunner falls back to the personal default. Derived rather than sent
   * so the client and server cannot disagree.
   */
  loadout: WeaponId[] = [...DEFAULT_LOADOUT];

  playerId: number | null = null;
  crewId: number | null = null;
  seat: SeatId | null = null;
  /** Packed cosmetic look we ask the server to put on our car (M12). */
  look: number = packLook(DEFAULT_LOOK);
  /** Our callsign, sent with `hello` (set by the title screen). */
  callsign = '';
  /** How this player plays, sent with `hello` for anonymous statistics. */
  clientInfo: { input?: 'mouse' | 'gamepad' | 'touch'; quality?: string } = {};
  /** Per-browser token, so a car left mid-match can be taken back. */
  readonly sessionToken = loadSessionToken();
  /** Callsign per crew, from the server's roster. */
  readonly names = new Map<number, string>();
  /** True after a `welcome` that handed back a car we had left (REJOIN). */
  resumed = false;
  /** When (performance.now) the server stops holding a car we left; 0 = none. */
  private heldUntil = 0;

  private heldAskedAt = 0;

  /**
   * Seconds the server will still hold a car this browser left, or 0. While a
   * car is held the answer is refreshed every few seconds: the bot driving it
   * can lose it, and a REJOIN button for a wreck would be a lie.
   */
  get heldSeconds(): number {
    if (this.connected) return 0;
    const now = performance.now();
    if (this.heldUntil > now && now - this.heldAskedAt > 3000) this.askHeld();
    return Math.max(0, (this.heldUntil - now) / 1000);
  }

  private askHeld(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    this.heldAskedAt = performance.now();
    socket.send(JSON.stringify({ t: 'held?', token: this.sessionToken } satisfies ClientMessage));
  }
  connected = false;
  ping = 0;
  /** Aim relative to vehicle forward, already clamped to this seat's arc. */
  aimYaw = 0;
  aimPitch = 0;

  /**
   * The angles the muzzle is actually pointed at, after the parallax
   * correction. Kept apart from `aimYaw`/`aimPitch`, which are where the CAMERA
   * is looking: the camera drives the crosshair, and the crosshair drives these.
   * Firing one gun at once keeps them equal, but they are different questions.
   */
  shotYaw = 0;
  shotPitch = 0;

  /** The world point under the crosshair, or null. Sent with every shot. */
  aimPoint: { x: number; y: number; z: number } | null = null;
  /** Per slot: which twin-gun barrel we predict fires next (mirrors the server). */
  private barrels: number[] = [0, 0, 0];
  /** Per slot: earliest time (ms) the next shot may be sent. */
  private nextFireAt: number[] = [0, 0, 0];

  /** Our own combat state, mirrored from the authoritative snapshot. */
  self: {
    hp: number;
    hull: number;
    slot: number;
    rounds: number;
    magazine: number;
    reload: number;
    alive: boolean;
    weapon: string;
    automatic: boolean;
    /** True while the server is healing this crew at a crate (DESIGN.md §4.3). */
    repairing: boolean;
    /** Every slot's rounds and reload: car-mounted weapons each have a trigger. */
    allRounds: number[];
    allReloads: number[];
  } = {
    allRounds: [],
    allReloads: [],
    hp: COMBAT.maxCrewHealth,
    hull: COMBAT.maxHull,
    slot: 0,
    rounds: 0,
    magazine: WEAPONS.rifle.magazine,
    reload: 0,
    alive: true,
    repairing: false,
    weapon: WEAPONS.rifle.name,
    automatic: WEAPONS.rifle.automatic,
  };

  readonly conditions: NetConditions;
  readonly correction = { x: 0, y: 0, z: 0, yaw: 0 };

  private socket: ConditionedSocket | null = null;
  private url = '';
  private crewRequest: { crew?: number; seat?: SeatId } = {};
  /** True once the socket is open (not the same as joined). */
  private socketOpen = false;
  /** True once the player has asked to join, so a late socket open still joins. */
  private wantJoin = false;
  private seq = 0;
  private pending: InputCmd[] = [];
  private sendQueue: InputCmd[] = [];
  private ticksSinceSend = 0;
  private aimTimer = 0;

  private buffers: BufferedSnapshot[] = [];
  private renderTime = 0;
  private haveClock = false;

  private fireSeq = 0;
  /** Shots received since the last drain, for tracers and hit feedback. */
  private shotQueue: ShotEvent[] = [];
  /** Destructions received since the last drain, for the kill feed. */
  private killQueue: KillEvent[] = [];
  private pingId = 0;
  private pingSentAt = new Map<number, number>();
  private pingTimer = 0;
  private pingSamples: number[] = [];

  private renderLocal: VehicleState;
  /** Latest hull per crew, for damage smoke. Hull never touches the simulation. */
  private hulls = new Map<number, number>();
  private onStatus: (text: string) => void;
  /**
   * Diagnostics: what each reconcile had to correct. Replaying unacknowledged
   * inputs should reproduce the server's result almost exactly, so a non-trivial
   * delta here is the disagreement that shows up as a visual correction.
   */
  private reconcileSamples: Array<{ delta: number; replayed: number }> = [];
  /** Largest disagreement any single reconcile has had to correct, all run. */
  private maxDelta = 0;
  /** Largest reconciliation correction ever accumulated, all run. */
  private maxCorrectionSeen = 0;

  constructor(
    onStatus: (text: string) => void,
    conditions: NetConditions = NO_CONDITIONS,
    vehicleClass: VehicleClassId = DEFAULT_VEHICLE_CLASS,
  ) {
    this.onStatus = onStatus;
    this.conditions = conditions;
    this.vehicleClass = vehicleClass;
    const spawn = SPAWNS[0];
    const spec = VEHICLE_CLASSES[vehicleClass];
    this.local = createVehicle(spawn.x, spawn.y, spawn.z, spawn.yaw, spec);
    this.renderLocal = createVehicle(spawn.x, spawn.y, spawn.z, spawn.yaw, spec);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /** True when we are the one driving this vehicle. */
  get isDriver(): boolean {
    return this.seat === null || seatById(this.vehicleClass, this.seat)?.drives === true;
  }

  /**
   * True when our seat can fire. Independent of `isDriver`: the solo brawler's
   * occupant does both (DESIGN.md §2.3), and that is the whole mode.
   */
  get canFire(): boolean {
    return this.seat !== null && seatById(this.vehicleClass, this.seat)?.arc != null;
  }

  get conditioned(): boolean {
    return conditionsAreActive(this.conditions);
  }

  get jitter(): number {
    const samples = this.pingSamples;
    if (samples.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < samples.length; i++) total += Math.abs(samples[i] - samples[i - 1]);
    return total / (samples.length - 1);
  }

  get playerCount(): number {
    return this.members.size;
  }

  /** Local state with any pending correction applied. Use this to draw our car. */
  get renderState(): VehicleState {
    return this.renderLocal;
  }

  /** Size of the un-settled prediction error, in metres. The netcode's health metric. */
  get predictionError(): number {
    return Math.hypot(this.correction.x, this.correction.z);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Diagnostics: most recent reconcile corrections, oldest first. */
  get recentReconciles(): Array<{ delta: number; replayed: number }> {
    return this.reconcileSamples;
  }

  get maxReconcileDelta(): number {
    return this.maxDelta;
  }

  get maxCorrection(): number {
    return this.maxCorrectionSeen;
  }

  /** Diagnostics: the queue depth the server reported on its last snapshot. */
  get serverQueueDepth(): number {
    if (this.crewId === null) return -1;
    for (let i = this.buffers.length - 1; i >= 0; i--) {
      const entry = this.buffers[i].vehicles.get(this.crewId);
      if (entry) return entry.queued;
    }
    return -1;
  }

  /** Newest authoritative state for our own vehicle. Diagnostics and tests only. */
  authoritativeSelf(): VehicleSnapshot | null {
    if (this.crewId === null) return null;
    for (let i = this.buffers.length - 1; i >= 0; i--) {
      const entry = this.buffers[i].vehicles.get(this.crewId);
      if (entry) return entry;
    }
    return null;
  }

  // ------------------------------------------------------------------ connect

  /**
   * Open the connection. This does NOT join: joining is explicit (`join()`),
   * because a player should choose to enter the lobby rather than be dropped
   * into a live match the moment the page loads.
   */
  connect(url: string, crewRequest: { crew?: number; seat?: SeatId } = {}): void {
    this.url = url;
    this.crewRequest = crewRequest;
    this.onStatus(this.conditioned ? 'connecting (simulated network)…' : 'connecting…');
    const socket = new ConditionedSocket(url, this.conditions);
    this.socket = socket;

    socket.onopen = () => {
      this.socketOpen = true;
      this.onStatus('connected — ready to join');
      // Did we leave a match moments ago? The server knows (and whether the
      // car survived), so ask rather than guess from a local timestamp.
      this.askHeld();
      // If the player asked to join before the socket finished opening, honour it.
      if (this.wantJoin) this.sendHello();
    };

    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };

    socket.onclose = () => {
      this.socketOpen = false;
      this.connected = false;
      this.wantJoin = false;
      this.playerId = null;
      this.crewId = null;
      this.remotes.clear();
      this.members.clear();
      this.buffers.length = 0;
      // Forget the match we were in: its phase ("live") must not outlive the
      // connection, or the title would still behave as if driving.
      this.match = EMPTY_MATCH;
      // Back to the title: our car returns, parked, to the showroom spot it
      // started on — not left mid-arena at whatever speed it was doing.
      const spawn = SPAWNS[0];
      resetVehicle(this.local, spawn.x, spawn.y, spawn.z, spawn.yaw);
      resetVehicle(this.renderLocal, spawn.x, spawn.y, spawn.z, spawn.yaw);
      this.onStatus('disconnected');
    };

    socket.onerror = () => this.onStatus('connection error');
  }

  /** Join the lobby. The only thing that turns a connection into a seat. */
  join(): void {
    if (this.connected) return;
    this.wantJoin = true;
    if (this.socketOpen) this.sendHello();
  }

  private sendHello(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    // Declare vehicle class, and (dev only) a crew/seat preference. Sent before
    // any input so the server has placed us before we start predicting.
    const hello: ClientMessage = {
      t: 'hello',
      cls: this.vehicleClass,
      crew: this.crewRequest.crew,
      seat: this.crewRequest.seat,
      look: this.look,
      name: this.callsign,
      token: this.sessionToken,
      client: this.clientInfo,
    };
    socket.send(JSON.stringify(hello));
  }

  /**
   * Leave the match on purpose (the in-game menu): tell the server it is a
   * forfeit — no rejoin window — then drop and reopen the connection, which
   * returns the page to the title screen exactly as a fresh load would.
   */
  leave(): void {
    const socket = this.socket;
    if (socket && socket.readyState === 1) socket.send(JSON.stringify({ t: 'leave' } satisfies ClientMessage));
    socket?.close();
    if (this.url) {
      const url = this.url;
      const request = this.crewRequest;
      setTimeout(() => this.connect(url, request), 150);
    }
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome': {
        this.playerId = msg.id;
        this.crewId = msg.crew;
        this.seat = msg.seat;
        this.vehicleClass = msg.cls;
        this.connected = true;
        this.local.spec = VEHICLE_CLASSES[msg.cls];
        this.renderLocal.spec = VEHICLE_CLASSES[msg.cls];
        // What we hold follows from the seat: a car-mounted gun, or the
        // personal default for a window. Same rule the server applied.
        const seatDef = seatById(msg.cls, msg.seat);
        this.loadout = seatDef?.mounted ? mountedLoadout(seatDef) : [...DEFAULT_LOADOUT];
        this.barrels = [0, 0, 0];
        this.nextFireAt = [0, 0, 0];
        this.onStatus(this.conditioned ? 'in game (simulated network)' : 'in game');

        this.resumed = msg.resumed === true;
        // Start from the spawn the server actually placed the crew at (or, on a
        // rejoin, where our car is now), so the first snapshot doesn't arrive
        // as a large correction.
        const { x, y, z, yaw } = msg.spawn;
        resetVehicle(this.local, x, y, z, yaw);
        // Start the input stream from zero too: anything queued before admission
        // was never applied and must not be replayed from the new position.
        this.seq = 0;
        this.pending.length = 0;
        this.sendQueue.length = 0;
        this.ticksSinceSend = 0;
        this.correction.x = 0;
        this.correction.y = 0;
        this.correction.z = 0;
        this.correction.yaw = 0;
        break;
      }
      case 'held': {
        this.heldUntil = msg.seconds > 0 ? performance.now() + msg.seconds * 1000 : 0;
        break;
      }
      case 'roster': {
        this.names.clear();
        for (const [crew, name] of Object.entries(msg.names)) this.names.set(Number(crew), name);
        break;
      }
      case 'join': {
        if (!this.members.has(msg.id)) {
          this.members.set(msg.id, {
            id: msg.id,
            crew: msg.crew,
            seat: msg.seat,
            aimYaw: 0,
            aimPitch: 0,
            hp: COMBAT.maxCrewHealth,
            slot: 0,
            rounds: 0,
            allRounds: [],
            allReloads: [],
            reload: 0,
            alive: true,
          });
        }
        break;
      }
      case 'leave': {
        this.members.delete(msg.id);
        break;
      }
      case 'reject': {
        this.onStatus(`refused: ${msg.reason}`);
        break;
      }
      case 'pong': {
        const sentAt = this.pingSentAt.get(msg.id);
        if (sentAt !== undefined) {
          this.pingSentAt.delete(msg.id);
          this.ping = performance.now() - sentAt;
          this.pingSamples.push(this.ping);
          if (this.pingSamples.length > 12) this.pingSamples.shift();
        }
        break;
      }
      case 'snap': {
        this.onSnapshot(msg);
        break;
      }
    }
  }

  // -------------------------------------------------------------- prediction

  /**
   * Advance local prediction one fixed tick. Called from the fixed-step loop.
   *
   * Only the driver's input moves the car; a gunner calls this with neutral
   * input purely so their ride keeps interpolating smoothly between snapshots.
   */
  stepLocal(input: VehicleInput): void {
    // Not before admission. Predicting prior to `welcome` queues inputs the
    // server never saw and never acks, and `welcome` resets our position — so
    // reconciliation then replays that stale queue on top of the spawn and
    // shoves the car metres ahead of the authority until the queue drains.
    if (!this.connected) return;
    if (this.localDead) return; // the server is not simulating us; do not drift
    if (!this.isDriver) return; // gunners get their vehicle from snapshots

    this.seq++;
    const cmd: InputCmd = {
      seq: this.seq,
      throttle: input.throttle,
      steer: input.steer,
      handbrake: input.handbrake,
      boost: input.boost,
    };

    this.pending.push(cmd);
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.shift();

    this.sendQueue.push(cmd);
    stepVehicle(this.local, input, TICK.dt);

    const every = Math.max(1, Math.round(TICK.rate / NET.inputSendRate));
    if (++this.ticksSinceSend >= every) {
      this.ticksSinceSend = 0;
      this.flushInput();
    }
  }

  flushInput(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.sendQueue.length === 0) return;
    const msg: ClientMessage = { t: 'input', cmds: this.sendQueue };
    socket.send(JSON.stringify(msg));
    this.sendQueue = [];
  }

  /**
   * Set our aim. Clamped here for feel; the server clamps again because it is the
   * authority on what a window can reach.
   */
  /**
   * Pull the trigger. The server decides everything else: whether the seat is
   * armed, whether the weapon is loaded, whether enough time has passed, and
   * what the shot hits.
   */
  /** Our seat's car-mounted weapons, or null for a window gunner/driver. */
  get mounted(): readonly MountedWeapon[] | null {
    const seat = this.seat ? seatById(this.vehicleClass, this.seat) : undefined;
    return seat?.mounted ?? null;
  }

  /** Slot the player is firing with a given trigger: mounted by trigger, else held. */
  slotFor(trigger: 'primary' | 'secondary'): number | null {
    const mounted = this.mounted;
    if (!mounted) return trigger === 'primary' ? this.self.slot : null;
    const index = mounted.findIndex((m) => m.trigger === trigger);
    return index >= 0 ? index : null;
  }

  /**
   * Whether a slot may fire NOW: alive, loaded, not reloading, and its rate of
   * fire allows another round. Checked locally so we only send — and only draw a
   * tracer for — shots the server will accept. Without this a held trigger sent a
   * shot (and drew a tracer) every frame: 120/s at 120 fps against a gun the
   * server fires 9 times a second, so most tracers on screen never happened.
   */
  canShoot(slot: number, now = performance.now()): boolean {
    if (!this.canFire || this.localDead || !this.self.alive) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    if ((this.self.allReloads[slot] ?? this.self.reload) > 0) return false;
    if ((this.self.allRounds[slot] ?? this.self.rounds) <= 0) return false;
    return now >= (this.nextFireAt[slot] ?? 0);
  }

  /**
   * Pull a trigger. Only call when `canShoot(slot)` is true. Sends the crosshair's
   * world point so the server fires each muzzle toward it.
   */
  fire(slot = this.self.slot, now = performance.now()): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const weapon = weaponInSlot(this.loadout, slot);
    // Schedule rather than "last + interval": a late frame then doesn't push
    // every following shot late too, so the felt rate matches the real one.
    this.nextFireAt[slot] = Math.max(now, this.nextFireAt[slot] ?? 0) + 1000 / weapon.rate;
    // Count the round locally until the next snapshot says otherwise, so an
    // emptying magazine stops drawing tracers on time.
    if (this.self.allRounds[slot] !== undefined) this.self.allRounds[slot] -= 1;
    if (slot === this.self.slot) this.self.rounds -= 1;

    this.fireSeq++;
    const msg: ClientMessage = {
      // The RTT lets the server rewind to what we could actually see. It is our
      // own measurement and therefore not trusted — the server clamps it.
      t: 'fire',
      seq: this.fireSeq,
      yaw: this.shotYaw,
      pitch: this.shotPitch,
      rtt: this.ping,
      slot,
      ...(this.aimPoint ? { target: { ...this.aimPoint } } : {}),
    };
    socket.send(JSON.stringify(msg));
  }

  requestReload(slot?: number): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.canFire) return;
    const msg: ClientMessage = slot === undefined ? { t: 'reload' } : { t: 'reload', slot };
    socket.send(JSON.stringify(msg));
  }

  /**
   * Where each of a mounted weapon's guns is actually pointing, relative to the
   * car, clamped to how far it turns — for drawing the guns and their reticles.
   */
  mountedAims(): Array<{ yaw: number; pitch: number }> {
    // Depends only on the seat (and our predicted car), so it always returns
    // one aim per mounted weapon once seated — callers index it by slot.
    const mounted = this.mounted;
    if (!mounted) return [];
    const state = this.local;
    return mounted.map((weapon) => {
      const mount = weapon.mounts[0];
      const pivot = vehiclePointWorld(state, mount.pivot);
      const aim = this.aimPoint
        ? relativeAim(state.yaw, pivot, this.aimPoint)
        : { yaw: this.aimYaw, pitch: this.aimPitch };
      return {
        yaw: clampToArc(weapon.yawArc, aim.yaw),
        pitch: clamp(aim.pitch, weapon.pitchArc[0], weapon.pitchArc[1]),
      };
    });
  }

  switchWeapon(slot: number): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || !this.canFire) return;
    const msg: ClientMessage = { t: 'switch', slot };
    socket.send(JSON.stringify(msg));
  }

  /** Vote for a rematch from the results screen (DESIGN.md §12.1). */
  sendReady(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const msg: ClientMessage = { t: 'ready' };
    socket.send(JSON.stringify(msg));
  }

  /**
   * Our car and everyone else's, as combat sees them.
   *
   * Note what is NOT here: `hull`. A client has no business knowing another
   * crew's remaining integrity, and predicting with a value it invented would
   * make the prediction worse, not better.
   */
  private combatVehicles(): CombatVehicle[] {
    const vehicles: CombatVehicle[] = [];
    if (this.crewId !== null) vehicles.push(viewOf(this.local, this.crewId));
    for (const [crew, state] of this.remotes) vehicles.push(viewOf(state, crew));
    return vehicles;
  }

  private combatMembers(): CombatMember[] {
    const members: CombatMember[] = [];
    for (const m of this.members.values()) {
      members.push({ id: m.id, crew: m.crew, seat: m.seat, hp: m.hp, alive: m.alive });
    }
    return members;
  }

  /**
   * Reticle-ray aiming, step one: what the crosshair is over.
   *
   * The ray comes from the CAMERA, because that is where the crosshair is. The
   * answer is a world point, which the next step turns back into a muzzle angle.
   */
  aimPointFrom(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } {
    const weapon = weaponInSlot(this.loadout, this.self.slot);
    return resolveAimPoint(
      this.combatVehicles(),
      this.crewId ?? -1,
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      weapon.range,
    );
  }

  /**
   * Reticle-ray aiming, step two: point the muzzle at that world point.
   *
   * Without this the crosshair and the gun disagree by the distance between the
   * camera and the window — about a metre — which is invisible at 200 m and a
   * complete miss against a car at 15 m. The correction is then clamped to the
   * window arc, because the arc is what the window can physically reach: near
   * its edge the crosshair points somewhere the gun cannot, and the gun is right.
   */
  setAimPoint(point: { x: number; y: number; z: number } | null): void {
    this.aimPoint = point ? { x: point.x, y: point.y, z: point.z } : null;
    const seat = this.seat ? seatById(this.vehicleClass, this.seat) : undefined;
    if (point === null || !this.canFire || !seat || this.crewId === null) {
      this.shotYaw = this.aimYaw;
      this.shotPitch = this.aimPitch;
      return;
    }

    const angles = aimAnglesAt(viewOf(this.local, this.crewId), seat, point);
    if (!angles) {
      this.shotYaw = this.aimYaw;
      this.shotPitch = this.aimPitch;
      return;
    }

    this.shotYaw = seat.arc ? clampToArc(seat.arc, angles.yaw) : angles.yaw;
    this.shotPitch = clamp(angles.pitch, -1.2, 1.2);
  }

  /**
   * Predict our own shot locally.
   *
   * A tracer that only appears after a round trip makes a weapon feel broken, so
   * the client resolves the shot itself for rendering — using the SAME geometry
   * the server uses, or the tracer would disagree with the damage that follows.
   * This is cosmetic only: the server still decides what actually happened, and
   * its verdict arrives as a shot event.
   */
  predictShot(slot = this.self.slot): {
    origin: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    hitCrew: number | null;
    hitPlayer: number | null;
    weapon: WeaponId;
  } | null {
    if (!this.canFire || this.seat === null || this.crewId === null) return null;
    if (!this.self.alive) return null;
    const seat = seatById(this.vehicleClass, this.seat);
    if (!seat || !seat.arc) return null;

    const weapon = weaponInSlot(this.loadout, slot);
    const mine = viewOf(this.local, this.crewId);

    // Aim the same way the server will (see `Room.handleFire`): a mounted gun
    // turns about its pivot toward the crosshair point, then fires from its
    // muzzle toward it, clamped to how far it turns; twin guns alternate.
    let muzzle = muzzleWorld(mine, seat);
    let shotYaw = this.shotYaw;
    let shotPitch = this.shotPitch;
    const mountedWeapon = seat.mounted?.[slot];
    if (mountedWeapon) {
      const aimed = aimMountedWeapon(this.local, mountedWeapon, this.barrels[slot]++, this.aimPoint, {
        yaw: this.aimYaw,
        pitch: this.aimPitch,
      });
      muzzle = aimed.muzzle;
      shotYaw = aimed.yaw;
      shotPitch = aimed.pitch;
    }

    const yaw = this.local.yaw + shotYaw;
    const cosPitch = Math.cos(shotPitch);
    const dx = -Math.sin(yaw) * cosPitch;
    const dy = Math.sin(shotPitch);
    const dz = -Math.cos(yaw) * cosPitch;

    // No rewind: we predict against what we can currently see, which is exactly
    // what the player is aiming at.
    const shot = resolveHitscan(
      this.combatVehicles(),
      this.combatMembers(),
      this.crewId,
      muzzle.x,
      muzzle.y,
      muzzle.z,
      dx,
      dy,
      dz,
      weapon.range,
      0,
    );
    return { origin: muzzle, end: shot.end, hitCrew: shot.hullHit, hitPlayer: shot.memberHit, weapon: weapon.id };
  }

  /**
   * Seat ids of the living crew in a vehicle, for rendering occupants.
   *
   * The renderer needs this to show a body only at windows that are actually
   * manned (DESIGN.md §3.2). Downed crew vanish from their window, which is
   * also the clearest possible signal that a seat has been cleared.
   */
  /** The member driving a crew's car (whose aim its mounted guns follow). */
  driverMember(crew: number): MemberSnapshot | undefined {
    for (const m of this.members.values()) if (m.crew === crew && m.seat === 'seat.driver') return m;
    return undefined;
  }

  occupantsOf(crew: number): Set<string> {
    const occupied = new Set<string>();
    for (const m of this.members.values()) {
      if (m.crew === crew && m.alive) occupied.add(m.seat);
    }
    return occupied;
  }

  /** Repair crates as last reported by the server. */
  crates: RepairCrateSnapshot[] = [];

  /** Live projectiles from the last snapshot, and when it arrived (ms). */
  projectiles: ProjectileSnapshot[] = [];
  projectilesAt = 0;

  /** Latest match flow state (phase, clock, score) from the server. */
  match: MatchSnapshot = EMPTY_MATCH;

  /** Latest closing-zone state, or null in a mode with no zone. */
  zone: ZoneState | null = null;

  /** Everyone's standing, for the results board (not interest-filtered). */
  board: BoardRow[] = [];

  /**
   * Per-crew life state. Kept out of `VehicleState` because death is match
   * bookkeeping, not simulation: the client needs it to stop drawing a car, but
   * predicting with it would mean predicting something the sim never sees.
   */
  private readonly deaths = new Map<
    number,
    { dead: boolean; respawnIn: number; placement: number | null }
  >();

  get localDead(): boolean {
    return this.crewId !== null && (this.deaths.get(this.crewId)?.dead ?? false);
  }

  get localRespawnIn(): number {
    return this.crewId !== null ? (this.deaths.get(this.crewId)?.respawnIn ?? 0) : 0;
  }

  /** Our final placing once eliminated in solo, else `null`. */
  get localPlacement(): number | null {
    return this.crewId !== null ? (this.deaths.get(this.crewId)?.placement ?? null) : null;
  }

  /** Whether another crew's vehicle is destroyed (skip drawing it). */
  isDead(crew: number): boolean {
    return this.deaths.get(crew)?.dead ?? false;
  }

  /**
   * Crews still in the fight, lowest id first. What the camera follows once we
   * are eliminated — a last-car-standing match is worth watching to the end.
   */
  survivingCrews(): number[] {
    const out: number[] = [];
    for (const crew of this.remotes.keys()) {
      if (!this.isDead(crew)) out.push(crew);
    }
    return out.sort((a, b) => a - b);
  }

  /** Latest known hull for a crew, for rendering damage (DESIGN.md §8). */
  hullOf(crew: number): number {
    return this.hulls.get(crew) ?? COMBAT.maxHull;
  }

  /** Shots received since the last call, for tracers. */
  drainShots(): ShotEvent[] {
    const shots = this.shotQueue;
    this.shotQueue = [];
    return shots;
  }

  /** Destructions received since the last call, for the kill feed. */
  drainKills(): KillEvent[] {
    const kills = this.killQueue;
    this.killQueue = [];
    return kills;
  }

  setAim(yaw: number, pitch: number, dt: number): void {
    const seat = this.seat ? seatById(this.vehicleClass, this.seat) : undefined;
    this.aimYaw = seat?.arc ? clampToArc(seat.arc, yaw) : yaw;
    this.aimPitch = clamp(pitch, -1.2, 1.2);

    // Until a corrected aim arrives, point the muzzle where the camera looks.
    // A shot fired in the first frame of a match should not go somewhere absurd.
    this.shotYaw = this.aimYaw;
    this.shotPitch = this.aimPitch;

    if (!this.canFire) return; // nothing to report: this seat has no arc
    this.aimTimer += dt;
    if (this.aimTimer < 1 / AIM_SEND_HZ) return;
    this.aimTimer = 0;

    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const msg: ClientMessage = { t: 'aim', yaw: this.aimYaw, pitch: this.aimPitch };
    socket.send(JSON.stringify(msg));
  }

  // ----------------------------------------------------------- reconciliation

  private onSnapshot(msg: SnapshotMessage): void {
    const vehicles = new Map<number, VehicleSnapshot>();
    for (const v of msg.vehicles) {
      vehicles.set(v.crew, v);
      this.hulls.set(v.crew, v.hull);
      this.remoteLooks.set(v.crew, v.look);
      this.deaths.set(v.crew, { dead: v.dead, respawnIn: v.respawnIn, placement: v.placement });
      // Other crews become remotes the first time we hear about them. Our own
      // crew is the car we are riding and is handled separately.
      if (v.crew !== this.crewId && !this.remotes.has(v.crew)) {
        const state = createVehicle(v.x, v.y, v.z, v.yaw, VEHICLE_CLASSES[v.cls]);
        copyComponents(v.components, state.components);
        this.remotes.set(v.crew, state);
      }
    }
    const members = new Map<number, MemberSnapshot>();
    for (const m of msg.members) members.set(m.id, m);

    if (msg.crates) this.crates = msg.crates;
    if (msg.match) this.match = msg.match;
    this.zone = msg.zone ?? null;
    this.board = msg.board ?? [];

    this.buffers.push({ time: msg.time, vehicles, members });
    while (this.buffers.length > 120) this.buffers.shift();

    // Member list is authoritative; adopt it wholesale.
    this.members.clear();
    for (const m of msg.members) this.members.set(m.id, m);

    // And our own combat state, including the weapon currently held.
    const me = this.playerId !== null ? members.get(this.playerId) : undefined;
    if (me) {
      const loadout = this.loadout;
      const weapon = weaponInSlot(loadout, me.slot);
      this.self = {
        hp: me.hp,
        hull: this.crewId !== null ? (vehicles.get(this.crewId)?.hull ?? 0) : 0,
        slot: me.slot,
        rounds: me.rounds,
        magazine: weapon.magazine,
        reload: me.reload,
        alive: me.alive,
        weapon: weapon.name,
        automatic: weapon.automatic,
        repairing: this.crewId !== null ? (vehicles.get(this.crewId)?.repairing ?? false) : false,
        allRounds: me.allRounds ?? [me.rounds],
        allReloads: me.allReloads ?? [me.reload],
      };
    }

    // Shots and kills are one-tick events; queue them for the renderer.
    for (const shot of msg.shots ?? []) this.shotQueue.push(shot);
    // Rockets in flight: the latest list and when it arrived, for drawing.
    this.projectiles = msg.projectiles ?? [];
    this.projectilesAt = performance.now();
    for (const kill of msg.kills ?? []) this.killQueue.push(kill);

    // Forget crews the server no longer reports.
    for (const crew of [...this.remotes.keys()]) {
      if (!vehicles.has(crew)) {
        this.remotes.delete(crew);
        this.remoteLooks.delete(crew);
      }
    }
    for (const crew of [...this.deaths.keys()]) {
      if (!vehicles.has(crew)) this.deaths.delete(crew);
    }

    // Only the driver reconciles: the vehicle is theirs to predict.
    if (this.crewId !== null) {
      const mine = vehicles.get(this.crewId);
      if (mine && this.isDriver) this.reconcile(mine, msg.ackSeq);
      // A passenger adopts part damage directly: they never predict motion, so
      // there is nothing to reconcile, but their HUD and smoke should be right.
      if (mine && !this.isDriver) copyComponents(mine.components, this.local.components);
    }
  }

  private reconcile(server: VehicleSnapshot, ackSeq: number): void {
    const beforeX = this.local.pos.x;
    const beforeY = this.local.pos.y;
    const beforeZ = this.local.pos.z;
    const beforeYaw = this.local.yaw;

    applyVehicleSnapshot(this.local, server);

    // Replay everything the server has not applied yet.
    this.pending = this.pending.filter((c) => c.seq > ackSeq);
    for (const cmd of this.pending) stepVehicle(this.local, cmd, TICK.dt);

    const delta = Math.hypot(beforeX - this.local.pos.x, beforeZ - this.local.pos.z);
    if (delta > this.maxDelta) this.maxDelta = delta;
    this.reconcileSamples.push({ delta, replayed: this.pending.length });
    if (this.reconcileSamples.length > 60) this.reconcileSamples.shift();

    // Remember the discrepancy instead of snapping to it.
    this.correction.x += beforeX - this.local.pos.x;
    this.correction.y += beforeY - this.local.pos.y;
    this.correction.z += beforeZ - this.local.pos.z;
    this.correction.yaw = wrapAngle(this.correction.yaw + wrapAngle(beforeYaw - this.local.yaw));
  }

  // -------------------------------------------------------- per-frame update

  update(dt: number): void {
    const decay = Math.exp(-NET.correctionRate * dt);
    this.correction.x *= decay;
    this.correction.y *= decay;
    this.correction.z *= decay;
    this.correction.yaw *= decay;
    if (Math.abs(this.correction.x) < 1e-4) this.correction.x = 0;
    if (Math.abs(this.correction.y) < 1e-4) this.correction.y = 0;
    if (Math.abs(this.correction.z) < 1e-4) this.correction.z = 0;
    if (Math.abs(this.correction.yaw) < 1e-4) this.correction.yaw = 0;

    const magnitude = Math.hypot(this.correction.x, this.correction.z);
    if (magnitude > this.maxCorrectionSeen) this.maxCorrectionSeen = magnitude;

    // Interpolation clock: runs on real time but never more than the delay
    // behind the newest snapshot, which avoids synchronising clocks entirely.
    const newest = this.buffers.length ? this.buffers[this.buffers.length - 1].time : 0;
    const target = newest - NET.interpDelayMs;
    if (!this.haveClock && newest > 0) {
      this.renderTime = target;
      this.haveClock = true;
    } else {
      this.renderTime = Math.max(this.renderTime + dt * 1000, target);
    }

    this.interpolateVehicles();

    // Our own car: predicted if we drive it, interpolated if we are riding.
    copyState(this.local, this.renderLocal);
    this.renderLocal.pos.x += this.correction.x;
    this.renderLocal.pos.y += this.correction.y;
    this.renderLocal.pos.z += this.correction.z;
    this.renderLocal.yaw = wrapAngle(this.renderLocal.yaw + this.correction.yaw);

    this.pingTimer += dt;
    if (this.pingTimer >= 1) {
      this.pingTimer = 0;
      this.sendPing();
    }
  }

  private sendPing(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return;
    const id = ++this.pingId;
    this.pingSentAt.set(id, performance.now());
    if (this.pingSentAt.size > 8) {
      const oldest = this.pingSentAt.keys().next().value;
      if (oldest !== undefined) this.pingSentAt.delete(oldest);
    }
    const msg: ClientMessage = { t: 'ping', id };
    socket.send(JSON.stringify(msg));
  }

  private interpolateVehicles(): void {
    const buffers = this.buffers;
    if (buffers.length === 0) return;

    const t = this.renderTime;
    let i = 0;
    while (i < buffers.length && buffers[i].time <= t) i++;
    const a = buffers[i - 1] ?? null;
    const b = buffers[i] ?? null;

    const place = (target: VehicleState, from: VehicleSnapshot, to: VehicleSnapshot, alpha: number) => {
      target.pos.x = lerp(from.x, to.x, alpha);
      target.pos.y = lerp(from.y, to.y, alpha);
      target.pos.z = lerp(from.z, to.z, alpha);
      target.vel.x = lerp(from.vx, to.vx, alpha);
      target.vel.y = lerp(from.vy, to.vy, alpha);
      target.vel.z = lerp(from.vz, to.vz, alpha);
      // Shortest-arc yaw so a car crossing ±π doesn't spin the long way round.
      target.yaw = from.yaw + wrapAngle(to.yaw - from.yaw) * alpha;
      target.pitch = lerp(from.pitch, to.pitch, alpha);
      target.roll = lerp(from.roll, to.roll, alpha);
      target.onGround = from.onGround;
      target.boost = lerp(from.boost, to.boost, alpha);
      target.forwardSpeed = lerp(from.forwardSpeed, to.forwardSpeed, alpha);
      target.slipSpeed = lerp(from.slipSpeed, to.slipSpeed, alpha);
      // Component health is discrete: it only ever steps down, so interpolating
      // it would be meaningless. Take the newer snapshot, which shows damage as
      // soon as it is known rather than a delay behind everything else.
      copyComponents(to.components, target.components);
    };

    const resolve = (crew: number): { from: VehicleSnapshot; to: VehicleSnapshot; alpha: number } | null => {
      const from = a?.vehicles.get(crew) ?? b?.vehicles.get(crew);
      const to = b?.vehicles.get(crew) ?? from;
      if (!from || !to) return null;
      let alpha = 0;
      if (a && b && b.time > a.time) alpha = clamp((t - a.time) / (b.time - a.time), 0, 1);
      return { from, to, alpha };
    };

    for (const [crew, state] of this.remotes) {
      const r = resolve(crew);
      if (r) place(state, r.from, r.to, r.alpha);
    }

    // A gunner's own vehicle is interpolated too, because they cannot predict it.
    if (this.crewId !== null && !this.isDriver) {
      const r = resolve(this.crewId);
      if (r) {
        place(this.local, r.from, r.to, r.alpha);
        this.local.spec = VEHICLE_CLASSES[r.from.cls];
      }
    }
  }

  /**
   * Background tabs have their animation frames throttled to roughly 1 Hz.
   * Left alone the driver stops sending input while the server keeps applying
   * the last one; on return the accumulator replays the missed time and the
   * interpolation clock has fallen behind. That combination is what made the
   * world appear to "catch up" when switching tabs.
   */
  private onVisibilityChange = (): void => {
    if (document.hidden) {
      if (this.isDriver) this.releaseControls();
      this.onStatus('paused (tab hidden)');
      return;
    }
    this.buffers.length = 0;
    this.haveClock = false;
    this.correction.x = 0;
    this.correction.y = 0;
    this.correction.z = 0;
    this.correction.yaw = 0;
    if (this.connected) {
      this.onStatus(this.conditioned ? 'in game (simulated network)' : 'in game');
    }
  };

  /** Push a neutral input so the server stops driving our car. */
  private releaseControls(): void {
    this.seq++;
    const neutral: InputCmd = {
      seq: this.seq,
      throttle: 0,
      steer: 0,
      handbrake: false,
      boost: false,
    };
    this.pending.push(neutral);
    this.sendQueue.push(neutral);
    this.flushInput();
  }
}

// -------------------------------------------------------------------- helpers

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** A combat view over a locally held vehicle state. */
function viewOf(state: VehicleState, crew: number): CombatVehicle {
  return { id: crew, cls: state.spec.id, state, hull: 0, history: [] };
}

function copyState(from: VehicleState, to: VehicleState): void {
  to.pos.x = from.pos.x;
  to.pos.y = from.pos.y;
  to.pos.z = from.pos.z;
  to.vel.x = from.vel.x;
  to.vel.y = from.vel.y;
  to.vel.z = from.vel.z;
  to.yaw = from.yaw;
  to.pitch = from.pitch;
  to.roll = from.roll;
  to.groundY = from.groundY;
  to.onGround = from.onGround;
  to.airborneTicks = from.airborneTicks;
  to.boost = from.boost;
  to.impact = from.impact;
  to.forwardSpeed = from.forwardSpeed;
  to.slipSpeed = from.slipSpeed;
  copyComponents(from.components, to.components);
}

function applyVehicleSnapshot(target: VehicleState, v: VehicleSnapshot): void {
  target.pos.x = v.x;
  target.pos.y = v.y;
  target.pos.z = v.z;
  target.vel.x = v.vx;
  target.vel.y = v.vy;
  target.vel.z = v.vz;
  target.yaw = v.yaw;
  target.pitch = v.pitch;
  target.roll = v.roll;
  target.onGround = v.onGround;
  target.boost = v.boost;
  target.forwardSpeed = v.forwardSpeed;
  target.slipSpeed = v.slipSpeed;
  // Prediction has to run with the same component health the server will, or a
  // damaged car is predicted as a healthy one and every reconcile fights it.
  copyComponents(v.components, target.components);
}

/**
 * A random per-browser token (localStorage), sent with `hello` so the server can
 * recognise a player who left a match moments ago. Not an identity: clearing
 * site data simply makes a new one.
 */
function loadSessionToken(): string {
  const key = 'convoy.session';
  try {
    const saved = localStorage.getItem(key);
    if (saved && saved.length >= 8) return saved;
    const fresh = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}
