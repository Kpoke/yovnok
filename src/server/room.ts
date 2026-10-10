/**
 * The authoritative room.
 *
 * Owns the truth for every crew's vehicle. Clients send input and aim; this
 * decides what actually happens (DESIGN.md §13.4). It runs the *shared*
 * simulation from `src/shared/` — the same code the client predicts with — which
 * is the whole reason the simulation was written free of DOM, renderer,
 * randomness and wall-clock time.
 *
 * M4 changed the unit of simulation. A vehicle now belongs to a CREW: several
 * players ride in it, one of them drives, and the rest are gunners whose guns
 * arrive at M5. Only the driver's input moves the car, so gunners ride the
 * authoritative state (interpolated) rather than predicting it — they cannot
 * predict an input they do not have.
 *
 * Structure mirrors something that has to scale later: a `Room` owns crews and a
 * tick loop, and the transport is passed in rather than created here. Battle
 * royale (§13.5) will need interest management and server meshing; keeping the
 * room ignorant of sockets is what makes that a change to one layer.
 */

import type { WebSocket } from 'ws';
import { COMBAT, HAZARD, MATCH, NET, REPAIR, TICK, VEHICLE_CLASSES, type VehicleClassId } from '../shared/config';
import {
  ARENA_HALF,
  DUEL_SPAWN_RADIUS,
  hazardAt,
  MAPS,
  raycastSolids,
  SOLO_SPAWN_RADIUS,
  spawnForTeam,
  useMap,
} from '../shared/arena';
import { DEFAULT_MAP, isMapId, MAP_IDS, type MapId } from '../shared/mapIds';
import { SpatialGrid } from '../shared/grid';
import {
  beginCountdown,
  createMatchState,
  matchRules,
  matchSnapshotOf,
  registerElimination,
  registerKill,
  tickMatch,
  type MatchMode,
  type MatchRules,
  type MatchState,
} from '../shared/match';
import {
  clampToArc,
  crewSize,
  mountedLoadout,
  seatById,
  seatsFor,
  type SeatDef,
  type SeatId,
} from '../shared/crews';
import {
  createAmmoState,
  DEFAULT_LOADOUT,
  fireInterval,
  weaponInSlot,
  type AmmoState,
  type WeaponId,
  scheduleShot,
} from '../shared/weapons';
import { clamp } from '../shared/math';
import {
  COMPONENT_IDS,
  COMPONENT_MAX,
  damageComponent,
  repairComponent,
} from '../shared/components';
import { canRepair } from '../shared/repair';
import {
  componentHit,
  damageHull,
  damageMember,
  headWorld,
  aimMountedWeapon,
  muzzleWorld,
  relativeAim,
  raycastVehicle,
  resolveHitscan,
  seatPointWorld,
  type CombatMember,
  type CombatVehicle,
} from '../shared/combat';
import {
  createVehicle,
  NEUTRAL_INPUT,
  resetVehicle,
  resolveRams,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../shared/vehicle';
import {
  buildZonePlan,
  outsideZone,
  seededRandom,
  zoneAt,
  zoneRules,
  type Rand,
  type ZonePlan,
  type ZoneRules,
  type ZoneState,
} from '../shared/zone';
import { botLook, DEFAULT_LOOK, packLook, unpackLook } from '../shared/cosmetics';
import { createBotMemory, decideBot, type BotEnemy, type BotMemory } from './bot';
import { botCallsign, callsignAllowed, sanitiseCallsign } from '../shared/callsign';
import { record } from './stats';
import type {
  BoardRow,
  ClientMessage,
  InputCmd,
  KillEvent,
  MemberSnapshot,
  ProjectileSnapshot,
  ServerMessage,
  ShotEvent,
  VehicleSnapshot,
} from '../shared/protocol';

/** A vehicle and the people in it. */
type Crew = {
  id: number;
  cls: VehicleClassId;
  state: VehicleState;
  /** playerId -> seat. */
  members: Map<number, SeatId>;
  driverId: number | null;
  /** Inputs received from the driver but not yet applied. */
  queue: InputCmd[];
  /** Reused when the queue runs dry, so a brief gap doesn't stall the car. */
  lastInput: VehicleInput;
  /** Highest input sequence applied. The driver replays above this. */
  ackSeq: number;
  lastInputAt: number;
  /** Diagnostics only: the throttle actually applied this tick. */
  appliedThrottle: number;
  /** Hull integrity. Reaching zero destroys the vehicle (DESIGN.md §4.2). */
  hull: number;
  /** True this tick while a crate is healing this crew, for HUD feedback. */
  repairing: boolean;
  /**
   * A destroyed crew waits, then respawns TOGETHER at its team spawn
   * (DESIGN.md §2.1). While dead the vehicle is not simulated and not drawn, so
   * a kill is a real pause in pressure rather than a teleport.
   */
  dead: boolean;
  /** Seconds left before a dead crew respawns. Zero while alive. */
  respawnIn: number;
  /** Final placing once eliminated in solo, else `null`. */
  placement: number | null;
  /**
   * Packed cosmetic look (M12). The crew wears the DRIVER's look; a car is a car
   * regardless of who else is riding in it. Purely visual — the simulation never
   * reads this.
   */
  look: number;
  /**
   * Recent transforms, for lag compensation. Kept short: half a second of
   * history is all a rewind ever needs, and it bounds the memory per vehicle.
   */
  history: Array<{ tick: number; x: number; y: number; z: number; yaw: number }>;
};

/** A repair crate. Server-owned: clients are told what is available, not asked. */
type RepairCrate = {
  id: number;
  x: number;
  z: number;
  /** Seconds of repair left before it is spent. */
  charge: number;
  /** Counts down while spent, then the crate returns. Static crates only. */
  respawnIn: number;
  /** Wreck salvage: temporary, never respawns, removed when spent or expired. */
  salvage: boolean;
  /** Seconds until a salvage pile is removed. Unused by static crates (0). */
  expiresIn: number;
};

/** A projectile in flight. Simulated here; clients only render it. */
type Projectile = {
  id: number;
  by: number;
  crew: number;
  weapon: WeaponId;
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
};

type Player = {
  id: number;
  /**
   * The socket, or `null` for a bot. A bot is a player in every other respect —
   * it occupies a seat, is simulated, appears in snapshots and can be hit — so
   * making the transport optional is the whole of "a bot is an occupant".
   */
  socket: WebSocket | null;
  /** True for an AI occupant. Never has a socket, never votes, never reaped. */
  bot: boolean;
  /** Stable per-bot offset for idle motion, so bots do not move in lockstep. */
  botPhase: number;
  /** Bot cross-tick state (target, reaction, burst). Unused by humans. */
  botMemory: BotMemory;
  /** False until `hello` arrives. Un-joined players are not simulated or sent. */
  joined: boolean;
  crew: number;
  seat: SeatId;
  /** Aim relative to vehicle forward, clamped to the seat's arc. */
  aimYaw: number;
  aimPitch: number;
  /** Highest sequence number ever accepted, to reject duplicates and replays. */
  highSeq: number;
  /** When any message last arrived, for the liveness check. */
  lastSeenAt: number;
  /** Personal health. Gunners can be shot out of their seats (DESIGN.md §4.2). */
  hp: number;
  alive: boolean;
  /** Packed cosmetic look this player chose (M12). Relayed, never simulated. */
  look: number;
  loadout: WeaponId[];
  ammo: AmmoState;
  /** Highest fire sequence accepted, to reject duplicates and replays. */
  lastFireSeq: number;
  /**
   * Per slot, the server-clock time the next shot is due. A schedule rather
   * than "last shot + interval" so network jitter does not reject a shot the
   * client sent exactly on time (see `FIRE_JITTER`), while the average rate
   * still cannot exceed the weapon's.
   */
  nextFireAt: number[];
  /** Per slot: which mount fires next, so twin guns alternate barrels. */
  barrel: number[];
  /** Seconds until a downed crew member returns to their seat. */
  respawnIn: number;
  /** Callsign shown in the feed and results (bots: generated from the id). */
  name: string;
  /** Per-browser token from `hello`, to hand a left car back on rejoin. */
  token: string | null;
  /**
   * While > now, this player LEFT a live match and a bot is driving their car;
   * a `hello` with the same token takes it back (`REJOIN_SECONDS`).
   */
  awayUntil: number;
  /** Crew ids this client is currently being sent, for interest hysteresis. */
  interest: Set<number>;
};

/**
 * Liveness timeout. Overridable so tests can prove the reaper works without
 * waiting the full production timeout.
 */
const CLIENT_TIMEOUT_MS = Number(process.env.CLIENT_TIMEOUT_MS ?? NET.clientTimeoutMs);

/** Socket-ping cadence. Overridable so the reaper can be tested in seconds. */
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? NET.heartbeatMs);

/** Match size, decided by the room. Separate playlists per crew size (§2). */
const CREW_SIZE = Number(process.env.CREW_SIZE ?? 4);

/**
 * Game mode, chosen once per room.
 *
 * `duel` is the two-crew respawn TDM of DESIGN.md §2.1. `solo` is one-man
 * teams, one life each, last car standing (§2.3) — the mode where the car
 * itself is the weapon.
 */
const MODE: MatchMode = process.env.MODE === 'solo' ? 'solo' : 'duel';

/** One vehicle per team. A duel is always two teams. */
const TEAM_COUNT = 2;

/** Solo field size and the floor for a match to begin. Tunable; expect to raise. */
const SOLO_CARS = Math.max(1, Math.floor(Number(process.env.SOLO_CARS ?? MATCH.soloCars)));
const SOLO_MIN_PLAYERS = Math.max(
  1,
  Math.floor(Number(process.env.SOLO_MIN_PLAYERS ?? MATCH.soloMinPlayers)),
);

/**
 * How many bots to place. `off`, `fill` (fill the field), or a field-size number.
 * Defaults to `fill` in solo — the mode exists to be played alone — and off in
 * duels, where a bot would be filling a seat in a human's car.
 */
const BOTS_SPEC = process.env.BOTS ?? (MODE === 'solo' ? 'fill' : 'off');
const BOT_TARGET: 'off' | 'fill' | number =
  BOTS_SPEC === 'off'
    ? 'off'
    : BOTS_SPEC === 'fill'
      ? 'fill'
      : Math.max(0, Math.floor(Number(BOTS_SPEC) || 0));

/**
 * Dev-only seat/crew assignment.
 *
 * Honouring a client's crew request in production would let players choose their
 * own team, so it is behind a flag. Tests and screenshots turn it on.
 */
const DEV_ASSIGNMENT = process.env.DEV_ASSIGN === '1';

/**
 * Dev-only crew placement: `DEV_PLACE="0:x,z,yaw|1:x,z,yaw"`.
 *
 * Exists so end-to-end tests can pin a line of fire instead of depending on
 * where the spawn ring happens to be. Without it, tuning the arena silently
 * breaks server tests for reasons that look like combat bugs.
 */
const DEV_PLACEMENTS = new Map<number, { x: number; z: number; yaw: number }>();
for (const entry of (process.env.DEV_PLACE ?? '').split('|')) {
  const match = /^(\d+):(-?[\d.]+),(-?[\d.]+)(?:,(-?[\d.]+))?$/.exec(entry.trim());
  if (!match) continue;
  DEV_PLACEMENTS.set(Number(match[1]), {
    x: Number(match[2]),
    z: Number(match[3]),
    yaw: match[4] === undefined ? 0 : Number(match[4]),
  });
}

/**
 * Match-clock overrides, for tests. Production values live in `MATCH`; a test
 * that wants to see a match END should not have to wait twelve minutes, and a
 * netcode harness should not have to wait out a lobby it does not care about.
 */
const envNumber = (name: string): number | undefined => {
  if (process.env[name] === undefined) return undefined;
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : undefined;
};

/** Rule keys a test may override. `mode` is not one: it decides the room. */
type NumericRule = Exclude<keyof MatchRules, 'mode'>;

const RULE_OVERRIDES: Partial<Record<NumericRule, number>> = (() => {
  const map: Array<[NumericRule, string]> = [
    ['killTarget', 'MATCH_KILL_TARGET'],
    ['timeLimitSeconds', 'MATCH_TIME_SECONDS'],
    ['countdownSeconds', 'MATCH_COUNTDOWN_SECONDS'],
    ['resultsSeconds', 'MATCH_RESULTS_SECONDS'],
    ['suddenDeathSeconds', 'MATCH_SUDDEN_DEATH_SECONDS'],
    ['vehicleRespawnSeconds', 'MATCH_RESPAWN_SECONDS'],
    ['minPlayersPerTeam', 'MATCH_MIN_TEAM_PLAYERS'],
    ['minPlayers', 'SOLO_MIN_PLAYERS'],
  ];
  const out: Partial<Record<NumericRule, number>> = {};
  for (const [key, name] of map) {
    const value = envNumber(name);
    if (value !== undefined) out[key] = value;
  }
  return out;
})();

/**
 * Zone schedule, with the same env overrides as the match clock so a test can
 * run a three-minute close in three seconds.
 */
const zoneOverride = (name: string, key: keyof ZoneRules): Partial<ZoneRules> => {
  const value = envNumber(name);
  return value === undefined ? {} : ({ [key]: value } as Partial<ZoneRules>);
};
const ZONE_RULES = zoneRules({
  ...zoneOverride('ZONE_PHASES', 'phases'),
  ...zoneOverride('ZONE_HOLD_SECONDS', 'holdSeconds'),
  ...zoneOverride('ZONE_SHRINK_SECONDS', 'shrinkSeconds'),
  ...zoneOverride('ZONE_START_RADIUS', 'startRadius'),
  ...zoneOverride('ZONE_END_RADIUS', 'endRadius'),
  ...zoneOverride('ZONE_DPS', 'damagePerSecond'),
  ...zoneOverride('ZONE_DPS_PER_PHASE', 'damagePerPhase'),
});

/**
 * Optional seed for the zone's random circle centres. Unset means real
 * randomness (each match ends somewhere different); set means a reproducible
 * plan, which is what tests use.
 */
const ZONE_SEED = process.env.ZONE_SEED === undefined ? null : Number(process.env.ZONE_SEED);

/**
 * Pin the match to `live` with no clock. Existing harnesses (netcode, combat)
 * are testing the simulation and the protocol, not the lobby; making them fight
 * the match clock would be testing two things at once and diagnosing neither.
 * The lobby has its own end-to-end test instead.
 */
const FORCE_LIVE = process.env.MATCH_FORCE_LIVE === '1';

/** A private room's player limits: no bots, so a match needs two people. */
export const PRIVATE_MIN_PLAYERS = 2;
export const PRIVATE_MAX_PLAYERS = 12;

/** Options for a room. A private room has a code and is joined only with it. */
export type RoomOptions = {
  /** Private room code; absent for a public match. */
  code?: string;
  /** The first map (public rooms rotate after each match). */
  map?: MapId;
  /** Pick a new map after each match (public rooms). */
  rotate?: boolean;
};

export class Room {
  /** Private room code, or null for a public room. */
  readonly code: string | null;
  /** The map this room's match is on, and the next one when decided. */
  private mapId: MapId;
  private nextMapId: MapId | null = null;
  private readonly rotate: boolean;
  /** Private rooms: who picks the map and starts the match. */
  private hostId: number | null = null;

  constructor(options: RoomOptions = {}) {
    this.code = options.code ?? null;
    this.mapId = options.map ?? DEFAULT_MAP;
    this.rotate = options.rotate ?? !this.code;
    this.crates = this.cratesFor(this.mapId);
    this.nextCrateId = this.crates.length;
    if (this.code) {
      // Every seat is a person: no bots, and two make a match.
      this.rules = { ...this.rules, minPlayers: PRIVATE_MIN_PLAYERS };
    }
  }

  get isPrivate(): boolean {
    return this.code !== null;
  }

  /** Make this room's map the active one before touching the simulation. */
  private enter(): void {
    useMap(this.mapId);
  }

  private cratesFor(id: MapId): RepairCrate[] {
    return MAPS[id].crates.map((p, i) => ({
      id: i,
      x: p.x,
      z: p.z,
      charge: REPAIR.capacitySeconds,
      respawnIn: 0,
      salvage: false,
      expiresIn: 0,
    }));
  }

  private players = new Map<number, Player>();
  private crews = new Map<number, Crew>();
  private nextPlayerId = 1;
  private nextCrewId = 0;
  private tick = 0;
  private accumulator = 0;
  private lastTime = 0;
  /** Last time the socket heartbeat was sent. See `serviceHeartbeat`. */
  private heartbeatAt = 0;
  /** Server clock when the current match went live, for the zone schedule. */
  private zoneStartedAt = 0;
  /** The circle plan for the live match, or null outside one. */
  private zonePlan: ZonePlan | null = null;
  /** Latest zone state, for the snapshot. Null in a mode without a zone. */
  private zone: ZoneState | null = null;
  /** Randomness for zone centres: seeded in tests, real in play. */
  private zoneRand: Rand = ZONE_SEED === null ? Math.random : seededRandom(ZONE_SEED);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Mode, team count and rules all follow from MODE; declared in that order. */
  private mode: MatchMode = MODE;
  private teamCount: number = MODE === 'solo' ? SOLO_CARS : TEAM_COUNT;
  private vehicleClass: VehicleClassId =
    MODE === 'solo' ? 'solo' : CREW_SIZE === 2 ? 'coupe' : 'suv';
  private projectiles: Projectile[] = [];
  private nextProjectileId = 1;
  /**
   * Repair crates. Created once from the arena definition; their charge and
   * respawn timers are the only mutable state.
   */
  private crates: RepairCrate[] = [];
  /** Ids for salvage piles, kept clear of the static crates' ids. */
  private nextCrateId = 0;
  /** Shots fired since the last snapshot, flushed with it. */
  private pendingShots: ShotEvent[] = [];
  /** Destructions since the last snapshot, for the kill feed. */
  private pendingKills: KillEvent[] = [];
  /**
   * Spatial index over crews, rebuilt once per snapshot. Interest management is
   * its first use; hit broadphase and repairs can share it later.
   */
  private grid = new SpatialGrid<number>(NET.interestRadius);

  /**
   * Match flow for this room. One match at a time — the room IS the lobby,
   * because a duel is exactly two crews and there is nothing to matchmake
   * (DESIGN.md §2.1).
   */
  private match: MatchState = createMatchState(this.teamCount, this.mode);
  private rules: MatchRules =
    MODE === 'solo'
      ? matchRules(1, { ...RULE_OVERRIDES, minPlayers: RULE_OVERRIDES.minPlayers ?? SOLO_MIN_PLAYERS })
      : matchRules(CREW_SIZE, RULE_OVERRIDES);
  /** Players who have voted for a rematch on the results screen. */
  private ready = new Set<number>();

  /** Humans in the match. Bots are occupants, not players (see §12.4). */
  get playerCount(): number {
    return this.humanCount();
  }

  get crewCount(): number {
    return this.crews.size;
  }

  /**
   * Operational snapshot for a health check. Deliberately no player identity and
   * no coordinates — an unauthenticated endpoint should not leak where anyone is.
   */
  health(): { players: number; crews: number; phase: string } {
    return { players: this.playerCount, crews: this.crews.size, phase: this.match.phase };
  }

  start(): void {
    if (this.timer) return;
    this.lastTime = performance.now();
    this.timer = setInterval(() => this.advance(), 1000 / (TICK.rate * 2));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ------------------------------------------------------------------ clients

  /**
   * @param initial  messages that already arrived before the room was chosen
   *   (the room manager routes on `hello`, so it hands that over with the socket)
   */
  addClient(socket: WebSocket, initial: ReadonlyArray<unknown> = []): void {
    const id = this.nextPlayerId++;
    const player: Player = {
      id,
      socket,
      bot: false,
      botPhase: 0,
      botMemory: createBotMemory(),
      joined: false,
      crew: -1,
      seat: 'seat.driver',
      aimYaw: 0,
      aimPitch: 0,
      highSeq: 0,
      lastSeenAt: performance.now(),
      hp: COMBAT.maxCrewHealth,
      alive: true,
      look: packLook(DEFAULT_LOOK),
      loadout: [...DEFAULT_LOADOUT],
      ammo: createAmmoState(),
      lastFireSeq: 0,
      nextFireAt: [0, 0, 0],
      barrel: [0, 0, 0],
      respawnIn: 0,
      name: '',
      token: null,
      awayUntil: 0,
      interest: new Set(),
    };
    this.players.set(id, player);

    socket.on('message', (data) => this.onMessage(player, data));
    socket.on('close', () => this.removeClient(id));
    socket.on('error', () => this.removeClient(id));
    // A protocol pong proves the socket is alive without any app involvement,
    // which is what lets a backgrounded tab keep its seat (see NET.heartbeatMs).
    socket.on('pong', () => {
      player.lastSeenAt = performance.now();
    });

    // Not admitted yet: `hello` says which crew and seat the client wants, and
    // the car it is given must match what it will render and predict with.
    console.log(`[room] connection ${id} awaiting hello`);
    for (const data of initial) this.onMessage(player, data);
  }

  // ------------------------------------------------- for the room manager

  /** Can a new player be placed here now? (Not mid-match, and a seat free.) */
  get joinable(): boolean {
    const phase = this.match.phase;
    if (this.isPrivate) return phase !== 'live' && this.humanCount() < PRIVATE_MAX_PLAYERS;
    return (phase === 'lobby' || phase === 'countdown') && this.humanCount() < this.teamCount;
  }

  /** A private room that is full or mid-match (a code-holder must wait). */
  get privateState(): 'open' | 'full' | 'live' {
    if (this.humanCount() >= PRIVATE_MAX_PLAYERS) return 'full';
    return this.match.phase === 'live' ? 'live' : 'open';
  }

  /** Lobby before countdown: used to prefer the room closest to starting. */
  get startingSoon(): boolean {
    return this.match.phase === 'countdown';
  }

  /** No human connected and no car held for one who left: safe to close. */
  get idle(): boolean {
    if (this.humanCount() > 0) return false;
    const now = performance.now();
    for (const p of this.players.values()) if (p.awayUntil > now && !p.socket) return false;
    for (const p of this.players.values()) if (p.socket) return false;
    return true;
  }

  /** Seconds a car is still held here for this browser token, or 0. */
  heldSecondsFor(token: string): number {
    const away = this.heldFor(token);
    return away ? Math.max(0, (away.awayUntil - performance.now()) / 1000) : 0;
  }

  // ---------------------------------------------------------------- bots (M8)

  /**
   * Humans currently in the room. Bots are excluded everywhere it matters:
   * match readiness, the rematch quorum, and the "is anyone actually playing"
   * gate — a server full of bots with nobody watching should idle, not run.
   */
  private humanCount(): number {
    let humans = 0;
    for (const player of this.players.values()) {
      if (player.joined && !player.bot) humans++;
    }
    return humans;
  }

  /** How many bots should exist right now (DESIGN.md §12.4: lobby fill). */
  private desiredBots(): number {
    if (BOT_TARGET === 'off' || this.isPrivate) return 0;
    const field = BOT_TARGET === 'fill' ? this.teamCount : Math.min(BOT_TARGET, this.teamCount);
    return Math.max(0, field - this.humanCount());
  }

  /**
   * Bring the bot population to its target. Called from the lobby and match
   * transitions, never during `live` — no bot may decide a live competitive
   * result (§12.4). A human joining the lobby displaces a bot rather than being
   * turned away, which is what "bots fill the seats humans left" means.
   */
  private syncBots(): void {
    if (BOT_TARGET === 'off') return;
    if (this.match.phase === 'live') return;

    let bots = 0;
    for (const player of this.players.values()) if (player.bot && player.joined) bots++;

    while (bots > this.desiredBots()) {
      const extra = [...this.players.values()].find((p) => p.bot && p.joined);
      if (!extra) break;
      this.removeBot(extra.id);
      bots--;
    }
    while (bots < this.desiredBots()) {
      if (!this.addBot()) break; // field is full of humans
      bots++;
    }
  }

  /** Place one bot in the first team with no occupants. Returns false if full. */
  private addBot(): boolean {
    let team = -1;
    for (let id = 0; id < this.teamCount; id++) {
      const crew = this.crews.get(id);
      if (!crew || crew.members.size === 0) {
        team = id;
        break;
      }
    }
    if (team < 0) return false;

    const crew = this.ensureCrew(team);
    const seat = seatsFor(crew.cls)[0].id;
    const id = this.nextPlayerId++;
    const seatDef = seatById(crew.cls, seat);
    const loadout = seatDef?.mounted ? mountedLoadout(seatDef) : [...DEFAULT_LOADOUT];

    const bot: Player = {
      id,
      socket: null,
      bot: true,
      botPhase: (id * 2.399) % (Math.PI * 2),
      botMemory: createBotMemory(),
      joined: true,
      crew: crew.id,
      seat,
      aimYaw: 0,
      aimPitch: 0,
      highSeq: 0,
      lastSeenAt: performance.now(),
      hp: COMBAT.maxCrewHealth,
      alive: true,
      look: packLook(botLook(id)),
      loadout,
      ammo: createAmmoState(loadout),
      lastFireSeq: 0,
      nextFireAt: [0, 0, 0],
      barrel: [0, 0, 0],
      respawnIn: 0,
      name: botCallsign(id),
      token: null,
      awayUntil: 0,
      interest: new Set(),
    };
    this.players.set(id, bot);
    crew.members.set(id, seat);
    if (seatDef?.drives) crew.driverId = id;
    this.broadcastRoster();
    return true;
  }

  private removeBot(id: number): void {
    const bot = this.players.get(id);
    if (!bot?.bot) return;
    this.players.delete(id);
    const crew = this.crews.get(bot.crew);
    if (crew) {
      crew.members.delete(id);
      if (crew.driverId === id) crew.driverId = null;
      if (crew.members.size === 0) this.crews.delete(crew.id);
    }
    this.broadcastRoster();
  }

  /**
   * Run every bot for one tick. Returns the drive input per bot-driven crew.
   *
   * The intent is applied through the SAME path a human's input takes, so a bot
   * cannot exceed an arc, a rate or a magazine — it is a player with a
   * different source of intent, not a privileged entity.
   */
  private stepBots(now: number): Map<number, VehicleInput> {
    const inputs = new Map<number, VehicleInput>();
    if (this.match.phase !== 'live') return inputs;
    // A private room has no bots: a car held for a player who dropped waits,
    // parked, for them to come back.
    if (this.isPrivate) return inputs;

    // Repair points are the same for every bot this tick, so build them once
    // rather than per bot per tick.
    const repairs = this.crates
      .filter((c) => c.charge > 0)
      .map((c) => ({ x: c.x, z: c.z }));

    for (const bot of this.players.values()) {
      if (!bot.bot || !bot.joined || !bot.alive) continue;
      const crew = this.crews.get(bot.crew);
      if (!crew || crew.dead) continue;
      const seat = seatById(crew.cls, bot.seat);
      if (!seat) continue;

      const intent = decideBot({
        vehicle: {
          id: crew.id,
          cls: crew.cls,
          state: crew.state,
          hull: crew.hull,
          history: crew.history,
        },
        seat,
        enemies: this.enemyViews(crew.id),
        time: now / 1000,
        phase: bot.botPhase,
        memory: bot.botMemory,
        zone: this.zone,
        hullFraction: crew.hull / COMBAT.maxHull,
        repairs,
      });

      bot.aimYaw = intent.aimYaw;
      bot.aimPitch = intent.aimPitch;
      if (seat.drives) inputs.set(crew.id, intent.input);
      // Each trigger fires at its own point, the way a human's crosshair would
      // (the bot decides when each weapon can bear; the rules still bind it).
      if (seat.arc && intent.fire) {
        this.handleFire(bot, crew, bot.lastFireSeq + 1, intent.aimYaw, intent.aimPitch, 0, 0, intent.target);
      }
      if (seat.mounted && seat.mounted.length > 1 && intent.fireSecondary) {
        this.handleFire(bot, crew, bot.lastFireSeq + 1, intent.aimYaw, intent.aimPitch, 0, 1, intent.secondaryTarget);
      }
    }
    return inputs;
  }

  /** Other crews' centres, for a bot to pick a target from. */
  private enemyViews(excludeCrew: number): BotEnemy[] {
    const out: BotEnemy[] = [];
    for (const crew of this.crews.values()) {
      if (crew.id === excludeCrew) continue;
      if (crew.dead || crew.members.size === 0) continue;
      out.push({
        id: crew.id,
        x: crew.state.pos.x,
        y: crew.state.pos.y,
        z: crew.state.pos.z,
        hullFraction: crew.hull / COMBAT.maxHull,
        vx: crew.state.vel.x,
        vz: crew.state.vel.z,
      });
    }
    return out;
  }

  /**
   * Place a player: choose a crew with room in it, and a free seat within it.
   * Crews fill evenly so a 2v2 does not start as a 4v0.
   */
  private assignSeats(
    requestedCrew: number | undefined,
    requestedSeat: SeatId | undefined,
  ): { crew: Crew; seat: SeatId } | null {
    const seats = seatsFor(this.vehicleClass);

    if (DEV_ASSIGNMENT && requestedCrew !== undefined) {
      const crew = this.ensureCrew(requestedCrew);
      const wanted = requestedSeat ? seatById(crew.cls, requestedSeat) : undefined;
      const free = [...crew.members.values()];
      const seat =
        wanted && !free.includes(wanted.id)
          ? wanted.id
          : (seats.find((s) => !free.includes(s.id))?.id ?? seats[seats.length - 1].id);
      return { crew, seat };
    }

    // The emptiest team takes the next player.
    //
    // Iterating only *existing* crews looks right but is not: the first player
    // creates crew 0, and the second then finds crew 0 to be the emptiest — and
    // joins it. Two players who should be opponents end up sharing a car.
    // Candidates are therefore the fixed team slots, not the crews that happen
    // to exist.
    //
    // In solo each team holds one player, so this degenerates to "the first
    // empty team", and a full field is genuinely full.
    const capacity = seatsFor(this.vehicleClass).length;
    let chosen = -1;
    let fewest = Infinity;
    for (let id = 0; id < this.teamCount; id++) {
      const count = this.crews.get(id)?.members.size ?? 0;
      if (count >= capacity) continue;
      if (count < fewest) {
        fewest = count;
        chosen = id;
      }
    }
    if (chosen < 0) return null; // field full

    const crew = this.ensureCrew(chosen);
    const taken = [...crew.members.values()];
    const seat = seatsFor(crew.cls).find((s) => !taken.includes(s.id))?.id ?? taken[taken.length - 1];
    return { crew, seat };
  }

  /**
   * Where a crew spawns and respawns: its team spawn, or a dev-pinned placement
   * so end-to-end tests can rely on a known position instead of the map.
   */
  private spawnOf(id: number): { x: number; y: number; z: number; yaw: number } {
    const placed = DEV_PLACEMENTS.get(id);
    if (placed) return { x: placed.x, y: 2, z: placed.z, yaw: placed.yaw };
    // Solo spreads over the whole rim; a duel starts compact near the middle.
    const radius = this.mode === 'solo' ? SOLO_SPAWN_RADIUS : DUEL_SPAWN_RADIUS;
    const spawn = spawnForTeam(id, this.teamCount, radius);
    return { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw };
  }

  private ensureCrew(id: number): Crew {
    let crew = this.crews.get(id);
    if (!crew) {
      const spawn = this.spawnOf(id);
      crew = {
        id,
        cls: this.vehicleClass,
        state: createVehicle(
          spawn.x,
          spawn.y,
          spawn.z,
          spawn.yaw,
          VEHICLE_CLASSES[this.vehicleClass],
        ),
        members: new Map(),
        driverId: null,
        repairing: false,
        queue: [],
        lastInput: { ...NEUTRAL_INPUT },
        ackSeq: 0,
        lastInputAt: performance.now(),
        appliedThrottle: 0,
        hull: COMBAT.maxHull,
        dead: false,
        respawnIn: 0,
        placement: null,
        look: packLook(DEFAULT_LOOK),
        history: [],
      };
      this.crews.set(id, crew);
      this.nextCrewId = Math.max(this.nextCrewId, id + 1);
    }
    return crew;
  }

  /** Admit a player once `hello` has arrived. Idempotent. */
  private admit(
    player: Player,
    cls: VehicleClassId,
    crewReq?: number,
    seatReq?: SeatId,
    look?: number,
  ): void {
    if (player.joined) return;

    // Dev only: the first client may set the room's vehicle class between the
    // two DUEL classes, which is how the coupe gets inspected without
    // reconfiguring the server. Solo overrides the class, so it is not offered.
    if (
      DEV_ASSIGNMENT &&
      MODE !== 'solo' &&
      this.crews.size === 0 &&
      (cls === 'coupe' || cls === 'suv')
    ) {
      this.vehicleClass = cls;
      // The kill target scales with crew size, so the rules follow the class.
      this.rules = matchRules(crewSize(cls), RULE_OVERRIDES);
    }

    let placement = this.assignSeats(crewReq, seatReq);
    if (!placement && this.match.phase !== 'live') {
      // A human displaces a bot in the lobby: bots fill the seats humans left,
      // not the other way round. Never done mid-match (§12.4).
      const bot = [...this.players.values()].find((p) => p.bot && p.joined);
      if (bot) {
        this.removeBot(bot.id);
        placement = this.assignSeats(crewReq, seatReq);
      }
    }
    if (!placement) {
      // The field is genuinely full of humans, or the match is live. Say so
      // rather than leaving the client connecting.
      this.send(player.socket, { t: 'reject', reason: 'match full' });
      console.log(`[room] player ${player.id} rejected: match full`);
      return;
    }
    const { crew, seat } = placement;
    player.joined = true;
    player.crew = crew.id;
    player.seat = seat;
    if (look !== undefined) player.look = packLook(unpackLook(look));
    crew.members.set(player.id, seat);
    if (seatById(crew.cls, seat)?.drives) crew.driverId = player.id;
    this.refreshCrewLook(crew);

    // The car may be the weapon: a seat with mounted guns defines the occupant's
    // loadout, so client and server agree on what is held without sending it.
    const seatDef = seatById(crew.cls, seat);
    if (seatDef?.mounted) {
      player.loadout = mountedLoadout(seatDef);
      player.ammo = createAmmoState(player.loadout);
    }

    const spawn = this.spawnOf(crew.id);
    this.send(player.socket, {
      t: 'welcome',
      id: player.id,
      cls: crew.cls,
      crew: crew.id,
      seat,
      tickRate: TICK.rate,
      snapshotRate: NET.snapshotRate,
      spawn: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw },
    });

    for (const other of this.players.values()) {
      if (other.id === player.id || !other.joined) continue;
      this.send(player.socket, { t: 'join', id: other.id, crew: other.crew, seat: other.seat });
      this.send(other.socket, { t: 'join', id: player.id, crew: player.crew, seat: player.seat });
    }

    this.send(player.socket, { t: 'map', id: this.mapId, next: this.nextMapId });
    if (this.isPrivate && (this.hostId === null || !this.players.get(this.hostId)?.socket)) this.hostId = player.id;

    console.log(
      `[room] player ${player.id} → crew ${crew.id} as ${seat} (${this.playerCount} players, ${this.crews.size} crews)`,
    );
    this.broadcastRoster();
    this.broadcastRoomState();
  }

  // ------------------------------------------------------- maps and private rooms

  /** Change this room's map (between matches): crates, spawns, everyone told. */
  private switchMap(id: MapId): void {
    this.mapId = id;
    this.nextMapId = null;
    this.enter();
    this.crates = this.cratesFor(id);
    this.nextCrateId = this.crates.length;
    // Out of a match, cars wait on the new map's spawns.
    if (this.match.phase !== 'live') for (const crew of this.crews.values()) this.respawnCrew(crew);
    for (const p of this.players.values()) this.send(p.socket, { t: 'map', id, next: null });
    this.broadcastRoomState();
    console.log(`[room] map → ${id}`);
  }

  /** Public rooms rotate: a different map for the next match, announced early. */
  private pickNextMap(): void {
    const others = MAP_IDS.filter((id) => id !== this.mapId);
    if (others.length === 0) return;
    this.nextMapId = others[Math.floor(Math.random() * others.length)];
    for (const p of this.players.values()) this.send(p.socket, { t: 'map', id: this.mapId, next: this.nextMapId });
  }

  /** The private lobby, to every member (each told whether they host). */
  private broadcastRoomState(): void {
    if (!this.code) return;
    const humans = [...this.players.values()].filter((p) => p.joined && !p.bot && p.socket);
    if (this.hostId === null || !humans.some((p) => p.id === this.hostId)) this.hostId = humans[0]?.id ?? null;
    const host = this.hostId !== null ? this.players.get(this.hostId) : undefined;
    const players = humans.map((p) => p.name);
    for (const p of humans) {
      this.send(p.socket, {
        t: 'room',
        code: this.code,
        host: p.id === this.hostId,
        hostName: host?.name ?? '',
        players,
        map: this.mapId,
        min: PRIVATE_MIN_PLAYERS,
        max: PRIVATE_MAX_PLAYERS,
      });
    }
  }

  /**
   * REJOIN: a player who left a live match moments ago gets their car back.
   *
   * When they left, `removeClient` handed the car to the bot brain and kept
   * their record (`awayUntil`). The new connection ADOPTS that record's car:
   * same crew and seat, ammo and health as they are now, and a `welcome` whose
   * spawn is where the car is, so prediction starts from the right place.
   */
  private resume(player: Player): boolean {
    if (!player.token) return false;
    const away = this.heldFor(player.token, player);
    if (!away) {
      const left = [...this.players.values()].find((p) => p !== player && p.token === player.token && p.awayUntil > 0);
      if (left) {
        const crew = this.crews.get(left.crew);
        const why = this.match.phase !== 'live' ? 'match over' : !crew || crew.dead ? 'car destroyed' : 'window passed';
        console.log(`[room] player ${player.id} could not rejoin (${why}); joining fresh`);
      }
      return false;
    }
    const crew = this.crews.get(away.crew)!;

    // The new connection takes the old record's place in the crew.
    crew.members.delete(away.id);
    this.players.delete(away.id);
    player.joined = true;
    player.crew = crew.id;
    player.seat = away.seat;
    player.look = away.look;
    player.loadout = away.loadout;
    player.ammo = away.ammo;
    player.hp = away.hp;
    player.alive = away.alive;
    player.aimYaw = away.aimYaw;
    player.aimPitch = away.aimPitch;
    crew.members.set(player.id, player.seat);
    if (crew.driverId === away.id) crew.driverId = player.id;
    crew.queue.length = 0;

    const pos = crew.state.pos;
    this.send(player.socket, {
      t: 'welcome',
      id: player.id,
      cls: crew.cls,
      crew: crew.id,
      seat: player.seat,
      tickRate: TICK.rate,
      snapshotRate: NET.snapshotRate,
      spawn: { x: pos.x, y: pos.y, z: pos.z, yaw: crew.state.yaw },
      resumed: true,
    });
    for (const other of this.players.values()) {
      if (other.id === player.id || !other.joined) continue;
      this.send(player.socket, { t: 'join', id: other.id, crew: other.crew, seat: other.seat });
      this.send(other.socket, { t: 'leave', id: away.id });
      this.send(other.socket, { t: 'join', id: player.id, crew: player.crew, seat: player.seat });
    }
    console.log(`[room] player ${player.id} REJOINED crew ${crew.id} (was ${away.id})`);
    record('rejoin', player.token, null);
    this.send(player.socket, { t: 'map', id: this.mapId, next: this.nextMapId });
    this.broadcastRoster();
    this.broadcastRoomState();
    return true;
  }

  // ---- anonymous statistics (stats.ts) ----
  private liveSince = 0;
  private matchRecorded = true;

  /** Once per match, at its end: the match, and each human's finish. */
  private recordMatch(now: number): void {
    this.matchRecorded = true;
    let humans = 0;
    let humanWon = false;
    for (const player of this.players.values()) {
      if (player.bot || !player.joined) continue;
      const crew = this.crews.get(player.crew);
      if (!crew) continue;
      humans++;
      const placement = crew.placement ?? (crew.dead ? null : 1);
      if (placement === 1) humanWon = true;
      record('result', player.token, null, { placement, kills: this.match.scores[crew.id] ?? 0 });
    }
    record('match', null, null, {
      minutes: Math.round(((now - this.liveSince) / 60_000) * 10) / 10,
      humans,
      bots: this.crews.size - humans,
      humanWon,
    });
  }

  /** The left player whose car is still held for this token, if any. */
  private heldFor(token: string, except?: Player): Player | null {
    if (this.match.phase !== 'live') return null;
    const now = performance.now();
    for (const p of this.players.values()) {
      if (p === except || p.token !== token || p.awayUntil <= now) continue;
      const crew = this.crews.get(p.crew);
      if (crew && !crew.dead) return p;
    }
    return null;
  }

  /** Callsign per crew: the driver's, else any member's. */
  private rosterNames(): Record<number, string> {
    const names: Record<number, string> = {};
    for (const crew of this.crews.values()) {
      const driver = crew.driverId !== null ? this.players.get(crew.driverId) : undefined;
      const member = driver ?? [...crew.members.keys()].map((id) => this.players.get(id)).find(Boolean);
      if (member?.name) names[crew.id] = member.name;
    }
    return names;
  }

  private broadcastRoster(): void {
    const names = this.rosterNames();
    for (const p of this.players.values()) if (p.socket && p.joined) this.send(p.socket, { t: 'roster', names });
  }

  /**
   * The crew wears the driver's look (M12). Falls back to any member, then to
   * the default — so a car is always paintable even before a driver joins.
   */
  private refreshCrewLook(crew: Crew): void {
    const driver = crew.driverId !== null ? this.players.get(crew.driverId) : undefined;
    if (driver) {
      crew.look = driver.look;
      return;
    }
    for (const memberId of crew.members.keys()) {
      const member = this.players.get(memberId);
      if (member) {
        crew.look = member.look;
        return;
      }
    }
    crew.look = packLook(DEFAULT_LOOK);
  }

  private removeClient(id: number): void {
    this.enter();
    const player = this.players.get(id);
    if (!player) return;

    // Left a live solo match with a car still in it (closed or reloaded the
    // tab): keep the car in the field with the bot brain at the wheel, and keep
    // the record for REJOIN_SECONDS so the same browser can take it back. The
    // field never suddenly loses a car, and an accidental reload is not a loss.
    const crew = this.crews.get(player.crew);
    if (
      MODE === 'solo' &&
      player.joined &&
      !player.bot &&
      player.token &&
      this.match.phase === 'live' &&
      crew &&
      !crew.dead
    ) {
      player.socket = null;
      player.bot = true;
      player.botMemory = createBotMemory();
      player.botPhase = (id * 2.399) % (Math.PI * 2);
      player.awayUntil = performance.now() + REJOIN_SECONDS * 1000;
      this.ready.delete(id);
      record('left', player.token, null, { held: true });
      console.log(`[room] player ${id} left mid-match; crew ${crew.id} held for ${REJOIN_SECONDS}s`);
      this.broadcastRoomState();
      return;
    }

    if (player.joined && !player.bot && this.match.phase === 'live' && crew && !crew.dead) {
      record('left', player.token, null, { held: false });
    }
    this.players.delete(id);
    this.ready.delete(id);

    if (player.joined) {
      const crew = this.crews.get(player.crew);
      if (crew) {
        crew.members.delete(id);
        if (crew.driverId === id) crew.driverId = null;
        // An empty crew is removed, so its slot can be reused by the next join.
        if (crew.members.size === 0) this.crews.delete(crew.id);
        // The paint follows the driver, so losing one can change the car.
        else this.refreshCrewLook(crew);
      }
      for (const other of this.players.values()) {
        this.send(other.socket, { t: 'leave', id });
      }
    }
    console.log(`[room] player ${id} left (${this.playerCount} players, ${this.crews.size} crews)`);
    this.broadcastRoster();
    this.broadcastRoomState();
  }

  private onMessage(player: Player, data: unknown): void {
    this.enter();
    player.lastSeenAt = performance.now();

    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return; // malformed input is dropped, never fatal
    }

    if (msg.t === 'hello') {
      const name = sanitiseCallsign(msg.name);
      // Not every callsign is shown: a blocked one becomes a generated name.
      player.name = name && callsignAllowed(name) ? name : botCallsign(player.id);
      player.token = typeof msg.token === 'string' && msg.token.length >= 8 && msg.token.length <= 64 ? msg.token : null;
      if (this.resume(player)) return;
      this.admit(player, msg.cls, msg.crew, msg.seat, msg.look);
      return;
    }

    // The title asking whether a car it left is still held (before joining).
    if (msg.t === 'held?') {
      const away = typeof msg.token === 'string' ? this.heldFor(msg.token) : null;
      const seconds = away ? Math.max(0, (away.awayUntil - performance.now()) / 1000) : 0;
      this.send(player.socket, { t: 'held', seconds });
      return;
    }

    // Leaving on purpose (the in-game menu) forfeits: no rejoin window.
    if (msg.t === 'leave') {
      player.token = null;
      this.removeClient(player.id);
      return;
    }

    if (!player.joined) return;

    if (msg.t === 'ping') {
      this.send(player.socket, { t: 'pong', id: msg.id });
      return;
    }

    if (msg.t === 'ready') {
      this.toggleReady(player);
      return;
    }

    // Private room, host only: pick the map, start the match.
    if (msg.t === 'roomMap' || msg.t === 'roomStart') {
      if (!this.isPrivate || player.id !== this.hostId) return;
      const phase = this.match.phase;
      if (phase !== 'lobby' && phase !== 'results') return;
      if (msg.t === 'roomMap') {
        if (isMapId(msg.map) && msg.map !== this.mapId) this.switchMap(msg.map);
        return;
      }
      if (this.humanCount() >= PRIVATE_MIN_PLAYERS) this.startCountdown(performance.now());
      return;
    }

    // Dev-only scoring hook for end-to-end tests (see protocol.ts). Behind the
    // same flag as crew/seat assignment, so it is unreachable in production.
    if (msg.t === 'devKill' && DEV_ASSIGNMENT) {
      const victim = this.crews.get(msg.victim);
      if (victim && this.match.phase === 'live') {
        this.destroyVehicle(victim, Number.isFinite(msg.by) ? msg.by : null);
      }
      return;
    }

    const crew = this.crews.get(player.crew);
    if (!crew) return;

    // Combat and driving exist only while a match is live. A shot accepted
    // during the countdown would let a team score before the whistle, and
    // accepting input would let a car roll off its spawn before "go".
    if (this.match.phase !== 'live') return;

    if (msg.t === 'input') {
      // Only the driver commands the vehicle. A gunner sending input is ignored
      // rather than trusted — the seat decides, not the client.
      if (crew.driverId !== player.id || !Array.isArray(msg.cmds)) return;

      for (const raw of msg.cmds) {
        const cmd = sanitise(raw);
        if (!cmd) continue;
        if (cmd.seq <= player.highSeq) continue;
        if (crew.queue.length >= NET.maxQueuedInputs) break;
        player.highSeq = cmd.seq;
        crew.queue.push(cmd);
      }
      return;
    }

    if (msg.t === 'aim') {
      const seat = seatById(crew.cls, player.seat);
      if (!seat || !seat.arc) return; // the driver is unarmed and has no arc
      if (!Number.isFinite(msg.yaw) || !Number.isFinite(msg.pitch)) return;
      // Clamp server-side. The client clamps for feel; the server clamps because
      // it is the authority on what a window can reach.
      player.aimYaw = clampToArc(seat.arc, msg.yaw);
      player.aimPitch = Math.max(-1.2, Math.min(1.2, msg.pitch));
      return;
    }

    if (msg.t === 'fire') {
      this.handleFire(player, crew, msg.seq, msg.yaw, msg.pitch, msg.rtt ?? 0, msg.slot, msg.target);
      return;
    }

    if (msg.t === 'reload') {
      const slot = validSlot(player, msg.slot) ?? player.ammo.slot;
      this.beginReload(player, slot);
      return;
    }

    if (msg.t === 'switch') {
      if (Number.isFinite(msg.slot) && msg.slot >= 0 && msg.slot < player.loadout.length) {
        // Switching cancels the held weapon's reload rather than letting it
        // finish invisibly.
        player.ammo.reload[player.ammo.slot] = 0;
        player.ammo.slot = Math.floor(msg.slot);
      }
      return;
    }

  }

  /**
   * Register a rematch vote. Only meaningful on the results screen; votes are
   * cleared whenever the match leaves it, so a stale "ready" cannot skip a
   * future lobby (DESIGN.md §12.1).
   */
  private toggleReady(player: Player): void {
    if (this.match.phase !== 'results') return;
    this.ready.add(player.id);

    // All connected HUMANS ready: start the next match immediately, keeping
    // crews and seats together. Bots do not vote, so counting them would make a
    // rematch impossible whenever the field was filled with them.
    let humans = 0;
    for (const other of this.players.values()) if (other.joined && !other.bot) humans++;
    if (humans > 0 && this.ready.size >= humans) this.startCountdown(performance.now());
  }

  /**
   * Open the countdown and reset the field.
   *
   * Called directly by the rematch vote as well as by `stepMatch`, which is why
   * the reset lives HERE rather than only in the phase-transition hook: a vote
   * changes the phase outside that hook, and without this a solo rematch started
   * with the last match's wrecks still dead — which instantly re-ended it.
   */
  private startCountdown(now: number): void {
    beginCountdown(this.match, now, this.rules);
    this.resetForMatch();
    this.ready.clear();
    this.zoneStartedAt = 0;
    this.zonePlan = null;
    this.zone = null;
    console.log('[room] match phase → countdown');
  }

  // ------------------------------------------------------------------ combat

  private beginReload(player: Player, slot: number): void {
    const weapon = weaponInSlot(player.loadout, slot);
    if ((player.ammo.reload[slot] ?? 0) > 0) return;
    if (player.ammo.rounds[slot] >= weapon.magazine) return;
    player.ammo.reload[slot] = weapon.reloadSeconds;
  }

  private stepReloads(): void {
    // Every slot reloads on its own clock: the RPG reloading never stops the guns.
    for (const player of this.players.values()) {
      for (let slot = 0; slot < player.ammo.reload.length; slot++) {
        if (player.ammo.reload[slot] <= 0) continue;
        player.ammo.reload[slot] -= TICK.dt;
        if (player.ammo.reload[slot] <= 0) {
          player.ammo.reload[slot] = 0;
          player.ammo.rounds[slot] = weaponInSlot(player.loadout, slot).magazine;
        }
      }
    }
    // Downed crew wait, then return to their seat if the car survived. A crew
    // whose VEHICLE is dead waits for the vehicle instead — the whole crew comes
    // back together, so reviving one gunner early would be wrong.
    for (const player of this.players.values()) {
      if (player.alive || player.respawnIn <= 0) continue;
      const crew = this.crews.get(player.crew);
      if (!crew || crew.dead) continue;
      player.respawnIn -= TICK.dt;
      if (player.respawnIn <= 0) {
        player.respawnIn = 0;
        player.hp = COMBAT.maxCrewHealth;
        player.alive = true;
        player.ammo = createAmmoState(player.loadout);
      }
    }
  }

  /**
   * Fire.
   *
   * Every rule is enforced here rather than trusted from the client: the seat
   * has an arc, the weapon has a rate and a magazine, and the shot is resolved
   * against the server's own geometry at a rewound position. The client's only
   * contribution is intent.
   */
  private handleFire(
    player: Player,
    crew: Crew,
    seq: number,
    aimYawRequested: number,
    pitchRequested: number,
    rtt: number,
    slotRequested?: number,
    targetRequested?: { x: number; y: number; z: number },
  ): void {
    if (!player.alive) return;
    const seat: SeatDef | undefined = seatById(crew.cls, player.seat);
    if (!seat || !seat.arc) return; // the driver is unarmed
    if (!Number.isFinite(seq) || seq <= player.lastFireSeq) return;

    // A car-mounted weapon fires by trigger; a window gunner fires what they hold.
    const slot = (seat.mounted ? validSlot(player, slotRequested) : undefined) ?? player.ammo.slot;
    if ((player.ammo.reload[slot] ?? 0) > 0) return;

    const weapon = weaponInSlot(player.loadout, slot);
    const now = performance.now();
    const interval = Math.max(fireInterval(weapon), COMBAT.minFireInterval) * 1000;
    const nextDue = scheduleShot(player.nextFireAt[slot] ?? 0, now, interval, FIRE_JITTER);
    if (nextDue === null) return;

    if (player.ammo.rounds[slot] <= 0) {
      this.beginReload(player, slot);
      return;
    }

    player.lastFireSeq = seq;
    player.nextFireAt[slot] = nextDue;
    player.ammo.rounds[slot] -= 1;

    // The crosshair's world point, when the client sent one. Validated: finite,
    // and not absurdly far, so a client cannot aim at a point that bends rules.
    const target =
      targetRequested &&
      Number.isFinite(targetRequested.x) &&
      Number.isFinite(targetRequested.y) &&
      Number.isFinite(targetRequested.z) &&
      Math.hypot(targetRequested.x - crew.state.pos.x, targetRequested.z - crew.state.pos.z) < MAX_TARGET_DISTANCE
        ? targetRequested
        : null;

    let muzzle: { x: number; y: number; z: number };
    let aimYaw: number;
    let pitch: number;
    const mountedWeapon = seat.mounted?.[slot];
    if (mountedWeapon) {
      // Twin guns alternate barrels; each converges on the crosshair point.
      const aimed = aimMountedWeapon(crew.state, mountedWeapon, player.barrel[slot]++, target, {
        yaw: aimYawRequested,
        pitch: pitchRequested,
      });
      muzzle = aimed.muzzle;
      aimYaw = aimed.yaw;
      pitch = aimed.pitch;
    } else {
      // Aim is clamped to the window the gunner is leaning out of. The client
      // clamps too, for feel; this is the authority.
      muzzle = muzzleWorld(crew, seat);
      const aim = target ? relativeAim(crew.state.yaw, muzzle, target) : { yaw: aimYawRequested, pitch: pitchRequested };
      aimYaw = clampToArc(seat.arc, aim.yaw);
      pitch = clamp(aim.pitch, -1.2, 1.2);
    }

    // Spread, applied as small jitter on the aim rather than a cone offset.
    const yaw = crew.state.yaw + aimYaw + (Math.random() * 2 - 1) * weapon.spread;
    const shotPitch = pitch + (Math.random() * 2 - 1) * weapon.spread;
    const cosPitch = Math.cos(shotPitch);
    const dx = -Math.sin(yaw) * cosPitch;
    const dy = Math.sin(shotPitch);
    const dz = -Math.cos(yaw) * cosPitch;

    if (weapon.delivery === 'hitscan') {
      // Rewind by the shooter's own round trip, clamped: they should hit what
      // they saw, but a client cannot ask to rewind the world arbitrarily.
      const rewind = clamp(rtt / 2000, 0, COMBAT.maxRewindSeconds);
      const shot = resolveHitscan(
        this.combatVehicles(),
        this.combatMembers(),
        crew.id,
        muzzle.x,
        muzzle.y,
        muzzle.z,
        dx,
        dy,
        dz,
        weapon.range,
        rewind,
      );

      const targetCrew = shot.hullHit !== null ? this.crews.get(shot.hullHit) : undefined;
      if (targetCrew) {
        if (shot.componentHit) {
          // A hit on a part damages the PART and not the hull. That is the
          // decision §4.2 asks for: stripping a wheel costs you the kill.
          damageComponent(targetCrew.state.components, shot.componentHit, weapon.damage);
        } else {
          this.hurt(targetCrew, weapon.damage, weapon.id);
          if (targetCrew.hull <= 0) this.destroyVehicle(targetCrew, crew.id);
        }
      }
      // Solo: the car IS the life — its hull is the only health bar. Occupant
      // damage (built for gunners leaning out of windows in crewed modes) would
      // otherwise kill a driver inside an intact car and leave it parked,
      // driverless and counted alive, until the zone ground it down (measured:
      // half the "zone kills" in solobench were exactly this).
      if (shot.memberHit !== null && this.mode !== 'solo') {
        const victim = this.players.get(shot.memberHit);
        if (victim) {
          damageMember(victim, weapon.damage);
          if (!victim.alive) {
            victim.respawnIn = COMBAT.crewRespawnSeconds;
            const victimCrew = this.crews.get(victim.crew);
            if (victimCrew?.driverId === victim.id) victimCrew.driverId = null;
          }
        }
      }

      this.pendingShots.push({
        by: player.id,
        crew: crew.id,
        weapon: weapon.id,
        ox: muzzle.x,
        oy: muzzle.y,
        oz: muzzle.z,
        ex: shot.end.x,
        ey: shot.end.y,
        ez: shot.end.z,
        hitCrew: shot.hullHit,
        hitPlayer: shot.memberHit,
        component: shot.componentHit,
      });
    } else {
      this.projectiles.push({
        id: this.nextProjectileId++,
        by: player.id,
        crew: crew.id,
        weapon: weapon.id,
        x: muzzle.x,
        y: muzzle.y,
        z: muzzle.z,
        px: muzzle.x,
        py: muzzle.y,
        pz: muzzle.z,
        vx: dx * weapon.speed,
        vy: dy * weapon.speed,
        vz: dz * weapon.speed,
        life: 6,
      });
    }

    // Auto-reload once the magazine runs dry, so an empty gun never silently
    // does nothing when the player pulls the trigger.
    if (player.ammo.rounds[slot] <= 0) this.beginReload(player, slot);
  }

  /**
   * A crew's vehicle has been destroyed (DESIGN.md §4.2).
   *
   * The whole crew goes down together and waits out `vehicleRespawnSeconds`,
   * then returns at their team spawn. `byTeam` credits the kill; it is null when
   * the destruction has no enemy author (which cannot currently happen, but the
   * signature makes the scoring dependency explicit rather than assumed).
   *
   * Idempotent: a rocket's direct hit and its splash can both reach zero on the
   * same tick, and only one of those may score.
   */
  private destroyVehicle(crew: Crew, byTeam: number | null): void {
    if (crew.dead) return;

    // How many cars were still driving including this one: the placing this car
    // earned, and the count the elimination check needs afterwards.
    const aliveBefore = this.aliveTeams();
    const now = performance.now();

    crew.dead = true;
    crew.hull = 0;
    crew.queue.length = 0;
    crew.lastInput = { ...NEUTRAL_INPUT };
    crew.appliedThrottle = 0;
    crew.driverId = null;

    if (this.mode === 'solo') {
      // One life. No respawn timer: the car is out until the next match.
      crew.respawnIn = 0;
      crew.placement = aliveBefore;
      // Wreck salvage: the fight leaves something worth taking (DESIGN.md §11).
      this.dropSalvage(crew.state.pos.x, crew.state.pos.z);
    } else {
      crew.respawnIn = this.rules.vehicleRespawnSeconds;
      crew.placement = null;
    }

    for (const member of crew.members.keys()) {
      const player = this.players.get(member);
      if (!player) continue;
      player.hp = 0;
      player.alive = false;
      player.respawnIn = this.mode === 'solo' ? 0 : this.rules.vehicleRespawnSeconds;
      player.ammo = createAmmoState(player.loadout);
    }

    if (byTeam !== null && byTeam !== crew.id) {
      registerKill(this.match, byTeam, now, this.rules);
    }
    // Feed entry for every destruction, including a zone kill (credits nobody).
    this.pendingKills.push({ byCrew: byTeam === crew.id ? null : byTeam, victimCrew: crew.id });

    // NOTE: last-standing is NOT decided here. It is checked once per tick in
    // `stepMatch`, after every death in the tick has landed. Deciding it inline
    // made the SECOND-to-last car to die the winner the instant `alive` hit 1 —
    // so a zone that wiped the whole field on one tick crowned a survivor who
    // died in the same tick. A simultaneous wipe is a draw.
  }

  /**
   * Teams that are still in a solo match: a car that is not destroyed and still
   * has a player in it. An abandoned car counts as gone, which is what makes a
   * disconnect end a match when it leaves one crew.
   */
  private aliveTeams(): number {
    let alive = 0;
    for (const crew of this.crews.values()) {
      if (!crew.dead && crew.members.size > 0) alive++;
    }
    return alive;
  }

  /** The single surviving crew, or `null` when none or several remain. */
  private lastAliveTeam(): number | null {
    let survivor: number | null = null;
    for (const crew of this.crews.values()) {
      if (crew.dead || crew.members.size === 0) continue;
      if (survivor !== null) return null;
      survivor = crew.id;
    }
    return survivor;
  }

  /**
   * Wreck salvage (DESIGN.md §11): a destroyed car leaves a temporary, contested
   * resupply where it died.
   *
   * Less charge than a real crate and a short life, so it is a reward for winning
   * a fight rather than a new landmark — and it is CAPPED, so a mass wipe does not
   * litter the map with free repairs.
   */
  private dropSalvage(x: number, z: number): void {
    const piles = this.crates.filter((c) => c.salvage);
    if (piles.length >= REPAIR.maxSalvage) {
      const oldest = piles[0];
      this.crates = this.crates.filter((c) => c !== oldest);
    }
    this.crates.push({
      id: this.nextCrateId++,
      x,
      z,
      charge: REPAIR.salvageSeconds,
      respawnIn: 0,
      salvage: true,
      expiresIn: REPAIR.salvageLifetimeSeconds,
    });
  }

  /** Bring a dead crew back — together, at their team spawn, in a fresh car. */
  private respawnCrew(crew: Crew): void {
    const spawn = this.spawnOf(crew.id);
    resetVehicle(crew.state, spawn.x, spawn.y, spawn.z, spawn.yaw);
    crew.history.length = 0;
    crew.hull = COMBAT.maxHull;
    crew.queue.length = 0;
    crew.lastInput = { ...NEUTRAL_INPUT };
    crew.dead = false;
    crew.respawnIn = 0;
    crew.placement = null;

    for (const member of crew.members.keys()) {
      const player = this.players.get(member);
      if (!player) continue;
      player.hp = COMBAT.maxCrewHealth;
      player.alive = true;
      player.respawnIn = 0;
      player.ammo = createAmmoState(player.loadout);
      if (seatById(crew.cls, player.seat)?.drives) crew.driverId = player.id;
    }
  }

  /** Advance projectiles, resolving impacts against the arena and vehicles. */
  private stepProjectiles(dt: number): void {
    if (this.projectiles.length === 0) return;
    const gravity = -9.8;
    const vehicles = this.combatVehicles();
    const members = this.combatMembers();
    const survivors: Projectile[] = [];

    for (const p of this.projectiles) {
      p.life -= dt;
      if (p.life <= 0) continue;

      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      p.vy += gravity * dt;

      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;

      const segX = nx - p.x;
      const segY = ny - p.y;
      const segZ = nz - p.z;
      const length = Math.hypot(segX, segY, segZ);
      if (length < 1e-6) continue;
      const dx = segX / length;
      const dy = segY / length;
      const dz = segZ / length;

      // The arena stops it; a vehicle stops it and takes the damage.
      const arena = raycastSolids(p.x, p.y, p.z, dx, dy, dz, length);
      let impact = arena ?? length;
      let hitCrew: number | null = null;
      let hitExit = 0;
      let hitVehicle: CombatVehicle | undefined;

      for (const vehicle of vehicles) {
        if (vehicle.id === p.crew) continue; // never your own car
        const hit = raycastVehicle(vehicle, p.x, p.y, p.z, dx, dy, dz, impact);
        if (hit) {
          impact = hit.distance;
          hitExit = hit.exit;
          hitCrew = vehicle.id;
          hitVehicle = vehicle;
        }
      }

      // A rocket into a wheel takes the wheel off, same as a bullet does.
      const component =
        hitVehicle && hitCrew !== null
          ? componentHit(hitVehicle, p.x, p.y, p.z, dx, dy, dz, impact, hitExit)
          : null;

      if (impact < length || hitCrew !== null) {
        const weapon = weaponInSlot([p.weapon], 0);
        const hx = p.x + dx * impact;
        const hy = p.y + dy * impact;
        const hz = p.z + dz * impact;

        if (hitCrew !== null) {
          const crew = this.crews.get(hitCrew);
          if (crew) {
            if (component) {
              damageComponent(crew.state.components, component, weapon.damage);
            } else {
              this.hurt(crew, weapon.damage, weapon.id);
              if (crew.hull <= 0) this.destroyVehicle(crew, p.crew);
            }
          }
        }
        // Splash, so a near miss still matters.
        if (weapon.splash > 0) {
          for (const crew of this.crews.values()) {
            if (crew.id === p.crew) continue;
            const distance = Math.hypot(
              crew.state.pos.x - hx,
              crew.state.pos.y - hy,
              crew.state.pos.z - hz,
            );
            if (distance > weapon.splash) continue;
            const falloff = 1 - distance / weapon.splash;
            this.hurt(crew, weapon.damage * 0.6 * falloff, `${weapon.id} splash`);
            if (crew.hull <= 0) this.destroyVehicle(crew, p.crew);
          }
          for (const member of this.mode === 'solo' ? [] : members) {
            if (member.crew === p.crew || !member.alive) continue;
            const vehicle = this.crews.get(member.crew);
            if (!vehicle) continue;
            const seat = seatById(vehicle.cls, member.seat);
            if (!seat) continue;
            const head = headWorld(vehicle, seat);
            const distance = Math.hypot(head.x - hx, head.y - hy, head.z - hz);
            if (distance > weapon.splash) continue;
            const victim = this.players.get(member.id);
            if (victim) damageMember(victim, weapon.damage * 0.5 * (1 - distance / weapon.splash));
          }
        }

        this.pendingShots.push({
          by: p.by,
          crew: p.crew,
          weapon: p.weapon,
          ox: p.px,
          oy: p.py,
          oz: p.pz,
          ex: hx,
          ey: hy,
          ez: hz,
          hitCrew,
          hitPlayer: null,
          component,
        });
        continue; // consumed
      }

      p.x = nx;
      p.y = ny;
      p.z = nz;
      survivors.push(p);
    }

    this.projectiles = survivors;
  }

  // ---------------------------------------------------- combat view adapters

  private combatVehicles(): CombatVehicle[] {
    const out: CombatVehicle[] = [];
    for (const crew of this.crews.values()) {
      out.push({ id: crew.id, cls: crew.cls, state: crew.state, hull: crew.hull, history: crew.history });
    }
    return out;
  }

  private combatMembers(): CombatMember[] {
    const out: CombatMember[] = [];
    for (const player of this.players.values()) {
      if (!player.joined) continue;
      out.push({
        id: player.id,
        crew: player.crew,
        seat: player.seat,
        hp: player.hp,
        alive: player.alive,
      });
    }
    return out;
  }

  // --------------------------------------------------------------------- loop

  private advance(): void {
    this.enter();
    const now = performance.now();
    let dt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    // A long stall (debugger, GC pause) must not trigger a burst of catch-up
    // ticks — that would fast-forward every car.
    if (dt > 0.25) dt = 0.25;

    this.accumulator += dt;

    let steps = 0;
    while (this.accumulator >= TICK.dt && steps < 8) {
      this.step();
      this.accumulator -= TICK.dt;
      steps++;
    }
    if (this.accumulator > TICK.dt * 8) this.accumulator = 0;
  }

  private step(): void {
    this.tick++;
    const now = performance.now();

    this.serviceHeartbeat(now);
    this.stepMatch(now);
    const live = this.match.phase === 'live';
    // Bot intent for this tick. Empty unless a match is live.
    const botInputs = this.stepBots(now);

    for (const crew of this.crews.values()) {
      // A destroyed crew is off the field. In a duel it waits out its respawn
      // timer; in solo one life is one life, and it stays out until the next
      // match. Either way it is not simulated, so its wreck is frozen in place.
      if (crew.dead) {
        if (this.mode === 'duel') {
          crew.respawnIn -= TICK.dt;
          if (crew.respawnIn <= 0) this.respawnCrew(crew);
        }
        continue;
      }

      if (!live) {
        // Between matches and during the countdown the cars sit still. Applying
        // the last input rather than neutral would let a crew roll out early.
        crew.queue.length = 0;
        crew.lastInput = { ...NEUTRAL_INPUT };
        crew.appliedThrottle = 0;
        stepVehicle(crew.state, NEUTRAL_INPUT, TICK.dt);
        this.recordHistory(crew);
        continue;
      }

      // A bot-driven crew takes the brain's input instead of a network queue.
      const botInput = botInputs.get(crew.id);
      if (botInput) {
        crew.appliedThrottle = botInput.throttle;
        stepVehicle(crew.state, botInput, TICK.dt);
        this.enforceBounds(crew);
        this.recordHistory(crew);
        continue;
      }

      const cmd = crew.queue.shift();
      if (cmd) {
        crew.lastInput = {
          throttle: cmd.throttle,
          steer: cmd.steer,
          handbrake: cmd.handbrake,
          boost: cmd.boost,
        };
        crew.ackSeq = cmd.seq;
        crew.lastInputAt = now;
      }

      // A driver that has gone quiet is assumed to have released the controls.
      // Reusing `lastInput` indefinitely is what let a backgrounded tab keep
      // driving at full throttle with nobody watching.
      const timedOut = now - crew.lastInputAt > NET.inputTimeoutMs;
      const applied = timedOut ? NEUTRAL_INPUT : crew.lastInput;
      crew.appliedThrottle = applied.throttle;
      stepVehicle(crew.state, applied, TICK.dt);
      this.enforceBounds(crew);
      this.recordHistory(crew);
    }

    // Car-on-car contacts are a PAIR, so they cannot live in `stepVehicle`.
    // Resolve them once, after every crew has moved.
    if (live) this.stepRams();

    this.stepReloads();
    if (live) {
      this.stepProjectiles(TICK.dt);
      this.stepHazards(TICK.dt);
      this.stepZone(now);
      this.stepRepairs(TICK.dt);
    }

    const every = Math.max(1, Math.round(TICK.rate / NET.snapshotRate));
    if (this.tick % every === 0) {
      this.reapSilentClients(now);
      this.broadcastSnapshot();
    }
  }

  /**
   * Resolve car-on-car rams and apply the damage (DESIGN.md §3.1).
   *
   * Server-side only: a ram depends on BOTH cars' state, which a client does not
   * authoritatively know, so it is a server event the prediction is corrected
   * into — exactly like a crew hit. `resolveRams` separates the cars and hands
   * back the damage; attributing it here keeps scoring in one place.
   */
  private stepRams(): void {
    const cars: Array<{ id: number; state: VehicleState }> = [];
    for (const crew of this.crews.values()) {
      if (!crew.dead) cars.push({ id: crew.id, state: crew.state });
    }

    for (const hit of resolveRams(cars)) {
      const crewA = this.crews.get(hit.a);
      const crewB = this.crews.get(hit.b);
      if (!crewA || !crewB || crewA.dead || crewB.dead) continue;

      this.hurt(crewA, hit.dmgA, 'ram');
      this.hurt(crewB, hit.dmgB, 'ram');

      // Credit the car that took LESS of the trade — it did the ramming. Both
      // can score when both die (a mutual kill is legitimate in a free-for-all).
      if (crewA.hull <= 0) this.destroyVehicle(crewA, hit.dmgB >= hit.dmgA ? crewB.id : null);
      if (crewB.hull <= 0) this.destroyVehicle(crewB, hit.dmgA >= hit.dmgB ? crewA.id : null);
    }
  }

  /**
   * Advance the match clock and phase (DESIGN.md §2.1).
   *
   * The rules live in `shared/match.ts`; this only feeds them the two things
   * they cannot know: the current time and how many humans are on each team.
   * Phase TRANSITIONS are handled here because they have server side effects —
   * resetting the field at the top of a match, or clearing rematch votes on the
   * way out of the results screen.
   */
  /**
   * All hull damage goes through here, so the bench can see WHAT is doing the
   * killing (`BENCH_STATS=1`: per-source damage and finishing blows, logged at
   * each match's end). Off, it is just `damageHull`.
   */
  private hurt(crew: Crew, amount: number, source: string): void {
    const before = crew.hull;
    damageHull(crew, amount);
    if (!BENCH_STATS || crew.dead) return;
    const s = (this.benchStats[source] ??= { damage: 0, kills: 0 });
    s.damage += before - crew.hull;
    if (before > 0 && crew.hull <= 0) {
      s.kills++;
      if (source === 'zone' && this.zone) {
        const out = Math.hypot(crew.state.pos.x - this.zone.x, crew.state.pos.z - this.zone.z) - this.zone.radius;
        const occupants = [...crew.members.keys()].map((id) => this.players.get(id));
        const bot = occupants.find((p) => p?.bot);
        const m = bot?.botMemory;
        const who = bot ? `bot run=${m?.run} stuck=${m?.stuckFor.toFixed(1)}` : 'human';
        console.log(`[bench] zone-kill ${who} hull-was=${before.toFixed(0)} out=${out.toFixed(0)}m radius=${this.zone.radius.toFixed(0)} speed=${crew.state.forwardSpeed.toFixed(1)} alive=${occupants.map((p) => p?.alive).join(',')}`);
      }
    }
  }

  private benchStats: Record<string, { damage: number; kills: number }> = {};

  private stepMatch(now: number): void {
    // Fill (or thin) the bots before judging readiness, so "one human plus a
    // field of bots" is a full lobby. No-op while live (§12.4).
    this.syncBots();

    const counts: number[] = Array.from({ length: this.teamCount }, () => 0);
    for (const player of this.players.values()) {
      if (!player.joined) continue;
      if (player.crew >= 0 && player.crew < counts.length) counts[player.crew]++;
    }

    // A room with no humans does not start a match, however many bots are in it:
    // idle servers should wait, not play to an empty house.
    // A private room starts only when its host says so: until the countdown,
    // readiness is nil (and during it, real, so dropping below two cancels it).
    const waitForHost = this.isPrivate && this.match.phase !== 'countdown';
    const readiness = this.humanCount() > 0 && !waitForHost ? counts : counts.map(() => 0);

    if (this.match.phase === 'results' && !this.matchRecorded && this.liveSince > 0) this.recordMatch(now);

    // A solo match usually ends from the elimination check, not here — so log
    // whenever the match is over and there is a tally waiting.
    if (BENCH_STATS && this.match.phase === 'results' && Object.keys(this.benchStats).length > 0) {
      console.log(`[bench] damage ${JSON.stringify(this.benchStats)}`);
      this.benchStats = {};
    }

    const before = this.match.phase;
    tickMatch(this.match, now, this.rules, readiness, FORCE_LIVE);
    if (before !== this.match.phase) {
      if (this.match.phase === 'live') {
        this.liveSince = now;
        this.matchRecorded = false;
      }
      if (this.match.phase === 'countdown') this.resetForMatch();
      else this.ready.clear();

      console.log(`[room] match phase ${before} → ${this.match.phase}`);
    }

    // The zone starts when the match does, and exists only while live. Its
    // circles are decided HERE, once, at the whistle.
    if (this.match.phase === 'live') {
      if (before !== 'live') {
        this.zoneStartedAt = now;
        this.zonePlan = buildZonePlan(ZONE_RULES, this.zoneRand);
      }
    } else {
      this.zone = null;
      this.zonePlan = null;
    }

    // Last car standing. Checked every tick rather than only when a car is
    // destroyed, so a player leaving and taking their crew with them also ends
    // the match when it leaves one survivor.
    if (this.mode === 'solo' && this.match.phase === 'live') {
      const alive = this.aliveTeams();
      if (alive <= 1) {
        registerElimination(this.match, alive, this.lastAliveTeam(), now, this.rules);
      }
    }

    // The results screen is self-limiting: if not everyone votes for a rematch,
    // the room drops back to the lobby and waits for players to gather.
    if (this.match.phase === 'results' && this.match.endsAt > 0 && now >= this.match.endsAt) {
      this.match.phase = 'lobby';
      this.match.endsAt = 0;
      this.ready.clear();
      console.log('[room] results expired → lobby');
    }

    // A match just ended: a public room picks the next map now, so pages can
    // load it during the results.
    if (this.match.phase !== this.seenPhase) {
      if (this.match.phase === 'results' && this.rotate) this.pickNextMap();
      this.seenPhase = this.match.phase;
    }
  }

  private seenPhase: MatchState['phase'] = 'lobby';

  /** Fresh field at the top of a match: crews home, healed, full crates. */
  private resetForMatch(): void {
    if (this.nextMapId) this.switchMap(this.nextMapId);
    for (const crew of this.crews.values()) this.respawnCrew(crew);
    this.projectiles.length = 0;
    this.pendingShots.length = 0;
    // Fresh crates, and no salvage carried over from the last match.
    this.crates = this.crates.filter((c) => !c.salvage);
    for (const crate of this.crates) {
      crate.charge = REPAIR.capacitySeconds;
      crate.respawnIn = 0;
    }
  }

  /**
   * Damaging ground (DESIGN.md §10.3).
   *
   * Hull only, and deliberately never lethal on its own. A hazard is a position
   * tax: it makes the ground you are standing on cost something, so sitting
   * still in a bad spot is punished and driving out of it is the answer. One
   * driver's mistake must not wipe a four-person crew instantly.
   */
  private stepHazards(dt: number): void {
    const floor = COMBAT.maxHull * HAZARD.hullFloor;
    for (const crew of this.crews.values()) {
      const rate = hazardAt(crew.state.pos.x, crew.state.pos.z);
      if (rate <= 0) continue;
      if (crew.hull <= floor) continue;
      damageHull(crew, rate * dt);
      if (crew.hull < floor) crew.hull = floor;
    }
  }

  /**
   * The closing danger zone (DESIGN.md §2.2).
   *
   * Solo only. Every car outside the safe circle takes hull damage that grows
   * each phase, and — unlike a hazard — the zone CAN destroy a car. That is the
   * point: it is what guarantees a last-car-standing match reaches an end
   * instead of the final two circling a 340 m arena. A zone kill credits no one.
   */
  private stepZone(now: number): void {
    if (this.mode !== 'solo' || !this.zonePlan) return;

    const state = zoneAt((now - this.zoneStartedAt) / 1000, this.zonePlan);
    this.zone = state;

    for (const crew of this.crews.values()) {
      if (crew.dead || crew.members.size === 0) continue;
      if (!outsideZone(state, crew.state.pos.x, crew.state.pos.z)) continue;
      this.hurt(crew, state.damagePerSecond * TICK.dt, 'zone');
      if (crew.hull <= 0) this.destroyVehicle(crew, null);
    }
  }

  /**
   * Repair crates (DESIGN.md §4.3).
   *
   * A crew holding position near a crate trades exposure for health: hull and
   * components come back over several seconds while the car sits still, which is
   * the most vulnerable thing it can choose to do. The crate is finite — a
   * bottomless one would turn a corner of the map into a fortress — and comes
   * back after a delay, so the resource itself is worth fighting over.
   */
  private stepRepairs(dt: number): void {
    for (const crew of this.crews.values()) crew.repairing = false;

    for (const crate of this.crates) {
      // Salvage is temporary: it ages out whether or not anyone uses it.
      if (crate.salvage) {
        crate.expiresIn -= dt;
        if (crate.expiresIn <= 0) continue;
      }

      if (crate.charge <= 0) {
        if (crate.salvage) continue; // a spent pile is gone, it does not return
        crate.respawnIn -= dt;
        if (crate.respawnIn <= 0) {
          crate.charge = REPAIR.capacitySeconds;
          crate.respawnIn = 0;
        }
        continue;
      }

      for (const crew of this.crews.values()) {
        const state = crew.state;
        const distance = Math.hypot(state.pos.x - crate.x, state.pos.z - crate.z);
        if (!canRepair({ distance, speed: state.forwardSpeed })) continue;

        const hullMissing = crew.hull < COMBAT.maxHull;
        const partsDamaged = COMPONENT_IDS.some((id) => state.components[id] < COMPONENT_MAX);
        if (!hullMissing && !partsDamaged) continue;

        if (hullMissing) {
          crew.hull = Math.min(COMBAT.maxHull, crew.hull + REPAIR.hullPerSecond * dt);
        }
        for (const id of COMPONENT_IDS) {
          repairComponent(state.components, id, REPAIR.componentPerSecond * dt);
        }
        crew.repairing = true;
        crate.charge -= dt;
        if (!crate.salvage) crate.respawnIn = REPAIR.respawnSeconds;
        break; // one crew at a time: repairing is not a shared activity
      }
    }

    // Drop salvage that has expired or been used up. Static crates stay.
    if (this.crates.some((c) => c.salvage && (c.expiresIn <= 0 || c.charge <= 0))) {
      this.crates = this.crates.filter((c) => !c.salvage || (c.expiresIn > 0 && c.charge > 0));
    }
  }

  /**
   * Recover a vehicle that has left the world.
   *
   * Collision should make this unreachable, but a corner gap in the perimeter
   * walls once let a car drive out of the arena, and the server is the only place
   * that can fix it authoritatively.
   */
  private enforceBounds(crew: Crew): void {
    const s = crew.state;
    const limit = ARENA_HALF + 12;
    if (s.pos.y < -10 || Math.abs(s.pos.x) > limit || Math.abs(s.pos.z) > limit) {
      const spawn = this.spawnOf(crew.id);
      resetVehicle(s, spawn.x, spawn.y, spawn.z, spawn.yaw);
      // A teleport makes the history lie: rewinding would put the car back
      // across the map. Start the record again from here.
      crew.history.length = 0;
    }
  }

  /** One transform per tick, so shots can be resolved against past positions. */
  private recordHistory(crew: Crew): void {
    crew.history.push({
      tick: this.tick,
      x: crew.state.pos.x,
      y: crew.state.pos.y,
      z: crew.state.pos.z,
      yaw: crew.state.yaw,
    });
    while (crew.history.length > COMBAT.historyTicks) crew.history.shift();
  }

  /**
   * Send a protocol ping to every live socket on a slow cadence.
   *
   * The browser answers these in its network stack, so a client whose page is
   * throttled or frozen — a background tab — still proves it is alive and keeps
   * its seat. Without it, the only liveness signal was app messages, and a tab
   * switch looked exactly like a dead connection.
   */
  private serviceHeartbeat(now: number): void {
    if (now - this.heartbeatAt < HEARTBEAT_MS) return;
    this.heartbeatAt = now;
    for (const player of this.players.values()) {
      const socket = player.socket;
      if (!socket || socket.readyState !== 1) continue;
      try {
        socket.ping();
      } catch {
        // A socket mid-close is fine; `close`/`error` will clean it up.
      }
    }
  }

  /**
   * Drop clients whose socket has stopped answering.
   *
   * A half-open connection never fires `close`, so without this a killed browser
   * lingers as a ghost player holding a seat. `lastSeenAt` is refreshed by BOTH
   * app messages and protocol pongs, so only a genuinely dead socket is reaped —
   * a backgrounded tab keeps ponging.
   */
  private reapSilentClients(now: number): void {
    for (const player of [...this.players.values()]) {
      if (player.bot) continue; // no socket, so silence is expected
      if (now - player.lastSeenAt > CLIENT_TIMEOUT_MS) {
        console.log(`[room] player ${player.id} timed out (silent)`);
        player.socket?.close();
        this.removeClient(player.id);
      }
    }
  }

  private broadcastSnapshot(): void {
    if (this.crews.size === 0) return;

    const allVehicles: VehicleSnapshot[] = [];
    for (const crew of this.crews.values()) allVehicles.push(vehicleSnapshotOf(crew));

    const allMembers: MemberSnapshot[] = [];
    for (const player of this.players.values()) {
      if (player.joined) allMembers.push(memberSnapshotOf(player));
    }

    const allProjectiles: ProjectileSnapshot[] = this.projectiles.map((p) => ({
      id: p.id,
      by: p.by,
      crew: p.crew,
      weapon: p.weapon,
      x: p.x,
      y: p.y,
      z: p.z,
      px: p.px,
      py: p.py,
      pz: p.pz,
    }));

    // Shots and kills are one-tick events: they ride with the snapshot and clear.
    const shots = this.pendingShots;
    this.pendingShots = [];
    const kills = this.pendingKills;
    this.pendingKills = [];

    const crates = this.crates.map((c) => ({
      id: c.id,
      x: c.x,
      z: c.z,
      ready: c.charge > 0,
      salvage: c.salvage,
    }));

    // The results board: one row per team, not interest-filtered (see protocol).
    const board: BoardRow[] = [];
    for (const crew of this.crews.values()) {
      board.push({
        crew: crew.id,
        kills: this.match.scores[crew.id] ?? 0,
        placement: crew.placement,
      });
    }

    // Match time is on the MONOTONIC clock (performance.now), not the wall
    // clock used for interpolation: a system clock change must not skip a match
    // forward. Only the remaining milliseconds cross the wire, so the client
    // never needs the two clocks to agree.
    const match = matchSnapshotOf(
      this.match,
      performance.now(),
      this.ready.size,
      this.playerCount,
      this.mode === 'solo' ? this.aliveTeams() : this.crews.size,
      allMembers.length,
    );

    const time = Date.now();

    // Rebuild the spatial index once, then answer every client's interest query
    // against it. At duel scale this is noise; it is what makes 30 cars a
    // per-client filter rather than 30 scans per client.
    this.grid.clear();
    for (const crew of this.crews.values()) {
      this.grid.insert(crew.state.pos.x, crew.state.pos.z, crew.id);
    }

    // ackSeq is per-recipient and describes the crew's input stream, so the
    // message is composed per client. Interest management is applied here too:
    // a client is only told about what is near it.
    for (const player of this.players.values()) {
      if (!player.joined) continue;
      const crew = this.crews.get(player.crew);
      const visible = this.interestFor(player, crew);

      const vehicles =
        visible === null ? allVehicles : allVehicles.filter((v) => visible.has(v.crew));
      const members = visible === null ? allMembers : allMembers.filter((m) => visible.has(m.crew));
      const projectiles =
        visible === null
          ? allProjectiles
          : allProjectiles.filter((p) => this.inRange(crew, visible, p.crew, p.x, p.z));
      const clientShots =
        visible === null
          ? shots
          : shots.filter((s) => this.inRange(crew, visible, s.crew, s.ox, s.oz));

      this.send(player.socket, {
        t: 'snap',
        tick: this.tick,
        time,
        ackSeq: crew ? crew.ackSeq : 0,
        vehicles,
        members,
        shots: clientShots,
        kills,
        board,
        projectiles,
        crates,
        zone: this.zone,
        match,
      });
    }
  }

  /**
   * Which crews a client should be told about, or `null` for "all of them".
   *
   * `null` covers the cases where filtering buys nothing or would hurt:
   * a duel (two cars, always relevant), and an eliminated player in solo, who is
   * spectating and needs the survivors rather than the circle around their wreck.
   *
   * Otherwise: everything within `interestRadius`, plus everything already known
   * until it passes `interestRadius + interestMargin`. The margin is hysteresis —
   * without it a car on the boundary would flicker in and out every snapshot.
   */
  private interestFor(player: Player, crew: Crew | undefined): Set<number> | null {
    if (this.mode !== 'solo') return null;
    if (!crew || crew.dead) return null;

    const keep = this.grid.queryRadius(
      crew.state.pos.x,
      crew.state.pos.z,
      NET.interestRadius + NET.interestMargin,
    );
    const keepSet = new Set(keep);
    for (const id of [...player.interest]) {
      if (!keepSet.has(id)) player.interest.delete(id);
    }

    const near = this.grid.queryRadius(crew.state.pos.x, crew.state.pos.z, NET.interestRadius);
    for (const id of near) player.interest.add(id);
    player.interest.add(crew.id); // always see ourselves

    return player.interest;
  }

  /** Is a thing near enough to matter to this client? Own crew always is. */
  private inRange(
    crew: Crew | undefined,
    visible: Set<number>,
    ownerCrew: number,
    x: number,
    z: number,
  ): boolean {
    if (visible.has(ownerCrew) || ownerCrew === crew?.id) return true;
    if (!crew) return true;
    const dx = x - crew.state.pos.x;
    const dz = z - crew.state.pos.z;
    const reach = NET.interestRadius + NET.interestMargin;
    return dx * dx + dz * dz <= reach * reach;
  }

  private send(socket: WebSocket | null, message: ServerMessage): void {
    if (!socket || socket.readyState !== 1) return; // 1 === OPEN; bots have none
    socket.send(JSON.stringify(message));
  }
}

// -------------------------------------------------------------------- helpers

function vehicleSnapshotOf(crew: Crew): VehicleSnapshot {
  const s = crew.state;
  return {
    crew: crew.id,
    cls: crew.cls,
    x: s.pos.x,
    y: s.pos.y,
    z: s.pos.z,
    vx: s.vel.x,
    vy: s.vel.y,
    vz: s.vel.z,
    yaw: s.yaw,
    pitch: s.pitch,
    roll: s.roll,
    onGround: s.onGround,
    boost: s.boost,
    forwardSpeed: s.forwardSpeed,
    slipSpeed: s.slipSpeed,
    look: crew.look,
    hull: crew.hull,
    repairing: crew.repairing,
    components: { ...crew.state.components },
    driver: crew.driverId,
    appliedThrottle: crew.appliedThrottle,
    queued: crew.queue.length,
    dead: crew.dead,
    respawnIn: crew.respawnIn,
    placement: crew.placement,
  };
}

/** A slot index the player's loadout actually has, or undefined. */
function validSlot(player: Player, slot: unknown): number | undefined {
  return typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot < player.loadout.length
    ? slot
    : undefined;
}

/**
 * How early (as a fraction of the fire interval) a shot may arrive and still be
 * accepted. Shots sent on schedule arrive bunched by network jitter; the
 * schedule (`nextFireAt`) keeps the average rate at the weapon's regardless.
 */
const FIRE_JITTER = 0.5;

/** Seconds a left player's car is held (bot-driven) for them to rejoin. */
const REJOIN_SECONDS = Number(process.env.REJOIN_SECONDS ?? 30);
/** Log per-source damage at each match's end (scripts/solobench.ts sets it). */
const BENCH_STATS = process.env.BENCH_STATS === '1';
/** Furthest crosshair point a shot will aim at; beyond any weapon's range. */
const MAX_TARGET_DISTANCE = 600;

function memberSnapshotOf(player: Player): MemberSnapshot {
  return {
    id: player.id,
    crew: player.crew,
    seat: player.seat,
    aimYaw: player.aimYaw,
    aimPitch: player.aimPitch,
    hp: player.hp,
    slot: player.ammo.slot,
    rounds: player.ammo.rounds[player.ammo.slot] ?? 0,
    reload: player.ammo.reload[player.ammo.slot] ?? 0,
    allRounds: [...player.ammo.rounds],
    allReloads: [...player.ammo.reload],
    alive: player.alive,
  };
}

/**
 * Validate and clamp a client-supplied input.
 *
 * DESIGN.md §13.8: server authority plus pragmatic validation. A client is never
 * trusted to send a well-formed or in-range command, because the client is open
 * source and therefore a known quantity.
 */
function sanitise(raw: unknown): InputCmd | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;

  if (typeof c.seq !== 'number' || !Number.isFinite(c.seq)) return null;
  if (typeof c.throttle !== 'number' || !Number.isFinite(c.throttle)) return null;
  if (typeof c.steer !== 'number' || !Number.isFinite(c.steer)) return null;
  if (typeof c.handbrake !== 'boolean') return null;
  if (typeof c.boost !== 'boolean') return null;

  return {
    seq: c.seq,
    throttle: Math.max(-1, Math.min(1, c.throttle)),
    steer: Math.max(-1, Math.min(1, c.steer)),
    handbrake: c.handbrake,
    boost: c.boost,
  };
}
