/**
 * Wire protocol between the client and the authoritative server.
 *
 * DESIGN.md §13.4. Two rules shape everything here:
 *
 *   - The server is the truth. Clients send INPUT and AIM, never state. A client
 *     cannot tell the server where it is, which is the primary anti-cheat
 *     posture (§13.8) and also what keeps prediction honest.
 *   - Every input carries a sequence number, because reconciliation depends on
 *     knowing exactly which inputs the server has already applied.
 *
 * M4 changed the shape of a snapshot: the simulated entity is now a **vehicle
 * owned by a crew**, not a vehicle per player. Vehicles and crew members are
 * therefore sent as separate lists — a vehicle has one state, and several people
 * ride in it.
 *
 * Snapshots use flat scalar fields rather than nested vectors: this is the hot
 * path, serialised per client per tick. (Binary encoding is the phase-2 upgrade
 * once battle royale brings 60–120 players — see §13.5.)
 */

import type { VehicleClassId } from './config';
import type { SeatId } from './crews';
import type { ComponentId } from './components';
import type { VehicleInput } from './vehicle';
import type { WeaponId } from './weapons';
import type { Components } from './components';
import type { MatchSnapshot } from './match';
import type { ZoneState } from './zone';

/** A single tick of input, tagged so the server can acknowledge it. */
export type InputCmd = VehicleInput & { seq: number };

/** One crew's vehicle, as far as rendering needs to know. */
export type VehicleSnapshot = {
  crew: number;
  cls: VehicleClassId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  /** Visual attitude; not simulated, but remotes must look right too. */
  pitch: number;
  roll: number;
  onGround: boolean;
  boost: number;
  forwardSpeed: number;
  slipSpeed: number;
  /**
   * Packed cosmetic look (M12) — paint, wheels, roof kit. Purely visual; the
   * server relays the driver's choice, it never reads it. See `shared/cosmetics`.
   */
  look: number;
  /** Hull integrity, 0..MAX_HULL. Zero destroys the vehicle (DESIGN.md §4.2). */
  hull: number;
  /** True while this crew is being repaired at a crate (DESIGN.md §4.3). */
  repairing: boolean;
  /**
   * Component health. Falls inside this vehicle's state rather than beside
   * `hull` because it changes how the car MOVES, so the client needs it to
   * predict (see `shared/components.ts`).
   */
  components: Components;
  /** Diagnostics: who is driving, and the throttle the server actually applied. */
  driver: number | null;
  appliedThrottle: number;
  /** Diagnostics: driver inputs waiting to be applied. Zero means the server
   *  was extrapolating from `lastInput` this tick. */
  queued: number;
  /**
   * True while this crew's vehicle is destroyed and waiting to respawn. A dead
   * vehicle is not simulated and not drawn; the whole crew comes back together
   * at their team spawn when `respawnIn` runs out (DESIGN.md §2.1).
   */
  dead: boolean;
  /** Seconds until a dead crew respawns. Zero while alive. */
  respawnIn: number;
  /**
   * Final placing once eliminated in a last-standing match, or `null`. Set when
   * the car is destroyed, to the number of cars that were still driving
   * *including* this one — so the first car out of eight places 8th.
   */
  placement: number | null;
};

/** One crew member: which vehicle they are in, where they look, and their state. */
export type MemberSnapshot = {
  id: number;
  crew: number;
  seat: SeatId;
  /** Aim relative to vehicle forward, already clamped to the seat's arc. */
  aimYaw: number;
  aimPitch: number;
  /** Personal health. Gunners can be shot out of their seats (DESIGN.md §4.2). */
  hp: number;
  /** Weapon slot this member is holding. */
  slot: number;
  /** Rounds left in the current magazine. */
  rounds: number;
  /** Seconds left in a reload, 0 when not reloading. */
  reload: number;
  /**
   * Every slot's rounds and reload, for car-mounted weapons that each have
   * their own trigger (and so their own HUD read-out). `rounds`/`reload` above
   * are the held slot's, for window gunners.
   */
  allRounds: number[];
  allReloads: number[];
  /** False once downed, until they respawn. */
  alive: boolean;
};

/**
 * A shot that was fired, for tracers and hit feedback.
 *
 * Sent as an event rather than derived from state: a hitscan shot exists for
 * exactly one tick, so there is no persistent thing to replicate.
 */
export type ShotEvent = {
  by: number;
  crew: number;
  weapon: WeaponId;
  /** Muzzle, in world space. */
  ox: number;
  oy: number;
  oz: number;
  /** Where the shot ended: the impact point, or maximum range. */
  ex: number;
  ey: number;
  ez: number;
  /** Set when it struck a vehicle. */
  hitCrew: number | null;
  /** Set when it struck a crew member. */
  hitPlayer: number | null;
  /** Set when it struck a component rather than plain hull (DESIGN.md §4.2). */
  component: ComponentId | null;
};

/**
 * A car was destroyed: who did it and to whom, for the kill feed.
 * `byCrew` is null when nothing scored it — the closing zone, today.
 */
export type KillEvent = {
  byCrew: number | null;
  victimCrew: number;
};

/**
 * One car's standing, for the results board.
 *
 * Deliberately NOT interest-filtered: a scoreboard that only showed you the cars
 * near you would be wrong. It is a handful of numbers per car, not entity state,
 * so it costs almost nothing to send whole.
 */
export type BoardRow = {
  crew: number;
  kills: number;
  /** Final placing once eliminated, else null while still driving. */
  placement: number | null;
};

/** A repair crate, as far as rendering needs to know. */
export type RepairCrateSnapshot = {
  /** Stable id, so a client can add and remove crates as salvage comes and goes. */
  id: number;
  x: number;
  z: number;
  /** False while the crate is spent and waiting to return. */
  ready: boolean;
  /** Wreck salvage: temporary, and drawn differently from a permanent crate. */
  salvage: boolean;
};

/** A travelling projectile, simulated server-side. */
export type ProjectileSnapshot = {
  id: number;
  by: number;
  crew: number;
  weapon: WeaponId;
  x: number;
  y: number;
  z: number;
  /** Previous position, so clients can draw a segment between ticks. */
  px: number;
  py: number;
  pz: number;
};

export type ServerMessage =
  | {
      t: 'welcome';
      id: number;
      cls: VehicleClassId;
      crew: number;
      seat: SeatId;
      tickRate: number;
      snapshotRate: number;
      /**
       * Where the server placed this crew. Sent so the client can start its
       * prediction at the right spot without duplicating the spawn rule — which
       * is mode-dependent (a solo field spreads over the whole ring) and must
       * not drift between the two sides.
       */
      spawn: { x: number; y: number; z: number; yaw: number };
      /**
       * True when this is a REJOIN: the player's car was kept in the match
       * (bot-driven) after they left, and `spawn` is where it is now.
       */
      resumed?: boolean;
    }
  /**
   * Reply to `held?`: seconds the server will still hold a car this browser
   * left mid-match (0: nothing held — it was destroyed, the match ended, or
   * the window passed). Drives the title's REJOIN button.
   */
  | { t: 'held'; seconds: number }
  /** Callsign per crew, sent whenever it changes (joins, leaves, bots). */
  | { t: 'roster'; names: Record<number, string> }
  | { t: 'join'; id: number; crew: number; seat: SeatId }
  | { t: 'leave'; id: number }
  /** Admission refused — currently only when a solo field is full. */
  | { t: 'reject'; reason: string }
  | { t: 'pong'; id: number }
  | {
      t: 'snap';
      /** Server tick this snapshot was taken at. */
      tick: number;
      /** Server clock, ms. Used as the interpolation time base. */
      time: number;
      /** Highest input sequence from THIS client that has been applied. */
      ackSeq: number;
      vehicles: VehicleSnapshot[];
      members: MemberSnapshot[];
      /** Shots fired since the previous snapshot. */
      shots: ShotEvent[];
      /** Cars destroyed since the previous snapshot, for the kill feed. */
      kills: KillEvent[];
      /** Everyone's standing, for the results board. Not interest-filtered. */
      board: BoardRow[];
      /** Live projectiles. Server-simulated; clients render them. */
      projectiles: ProjectileSnapshot[];
      /** Repair crates and whether each is still good for anything. */
      crates: RepairCrateSnapshot[];
      /**
       * The closing danger zone, or `null` when the mode has none. Sent whole
       * each snapshot because the radius is moving; the client only draws it,
       * never simulates it.
       */
      zone: ZoneState | null;
      /**
       * Match flow: phase, clock, score. In every snapshot rather than sent as
       * an event, because the clock is continuous and a client that joins or
       * reconnects mid-match must be able to reconstruct the whole state from
       * the next tick. Duel-scale snapshots can afford it.
       */
      match: MatchSnapshot;
    };

/** The snapshot message, named so consumers can hold one without the union. */
export type SnapshotMessage = Extract<ServerMessage, { t: 'snap' }>;

export type ClientMessage =
  /**
   * Sent immediately on connect: which vehicle class this player wants, and
   * optionally which crew and seat. Crew/seat requests are only honoured when
   * the server runs with dev assignment enabled — otherwise they are a way to
   * put yourself in a chosen crew.
   */
  | {
      t: 'hello';
      cls: VehicleClassId;
      crew?: number;
      seat?: SeatId;
      look?: number;
      /** Callsign; cleaned server-side with `sanitiseCallsign`. */
      name?: string;
      /**
       * A per-browser random token. If this player left a live match moments
       * ago, the server hands their (bot-driven) car back instead of placing
       * them anew. Identifies a browser, not a person — there are no accounts.
       */
      token?: string;
      /** For anonymous statistics only: how this player plays. */
      client?: { input?: 'mouse' | 'gamepad' | 'touch'; quality?: string };
    }
  /** Leave the match on purpose (the in-game menu): forfeit, no rejoin window. */
  | { t: 'leave' }
  /** Before joining: is a car this browser left still being held? */
  | { t: 'held?'; token: string }
  /** Driver only: batched inputs, oldest first. */
  | { t: 'input'; cmds: InputCmd[] }
  /** Gunner only: where they are looking, relative to vehicle forward. */
  | { t: 'aim'; yaw: number; pitch: number }
  /**
   * Pull the trigger. `seq` orders shots so the server can rate-limit and reject
   * replayed ones, exactly as it does input. The aim is included because a shot
   * is resolved against where the shooter was looking at that moment, not where
   * they are looking by the time it arrives.
   */
  | {
      t: 'fire';
      seq: number;
      yaw: number;
      pitch: number;
      rtt: number;
      /** Car-mounted weapons: which trigger's slot fired. Absent = held slot. */
      slot?: number;
      /**
       * The world point under the crosshair. When present the server fires from
       * each muzzle TOWARD it (within the gun's limits), so a shot lands where
       * the player aimed rather than parallel to the camera ray — the camera is
       * metres from the muzzle, so the two only meet at the target.
       */
      target?: { x: number; y: number; z: number };
    }
  | { t: 'reload'; slot?: number }
  | { t: 'switch'; slot: number }
  /**
   * Vote for a rematch from the results screen (DESIGN.md §12.1). When every
   * connected player has voted, the room starts the next match with the same
   * crews. Abandoned votes expire with the results screen.
   */
  | { t: 'ready' }
  /**
   * DEV ONLY (honoured only when the server runs with `DEV_ASSIGN=1`, exactly
   * like crew/seat requests): destroy `victim`'s vehicle, crediting `by`.
   *
   * Exists so end-to-end tests can exercise scoring and the respawn cycle
   * without a twenty-second shooting phase; a test that spends its runtime
   * grinding hull is a test that will be deleted the first time it is slow.
   * Ignored in production.
   */
  | { t: 'devKill'; victim: number; by: number }
  /** RTT probe; the server echoes the id straight back. */
  | { t: 'ping'; id: number };

/** Path the server listens on, and that Vite proxies to it in development. */
export const WS_PATH = '/ws';
