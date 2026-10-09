/**
 * Central tuning data.
 *
 * Every number that affects how the game FEELS lives here, deliberately in one
 * place, so handling can be iterated on without touching simulation logic.
 *
 * See DESIGN.md §14: these are tuning values, not design. Expect to change all
 * of them once a human drives the car.
 */

export const TICK = {
  /** Fixed simulation rate. Client and server must share this exactly. */
  rate: 60,
  dt: 1 / 60,
} as const;

/**
 * Combat tuning.
 *
 * `maxHull` is sized against the slow-TTK target (DESIGN.md §6): a lone rifle at
 * 17 damage and 9 rounds/second is 153 dps, so a full hull is roughly eight
 * seconds of uninterrupted fire from one gunner — long enough that positioning,
 * disengaging and repairs all matter, and halved when two gunners coordinate.
 */
export const COMBAT = {
  maxHull: 1200,
  maxCrewHealth: 100,
  /**
   * Radius of a crew member's hittable head, in metres. Sized to the visible
   * head (§`buildSeat`) rather than tuned for difficulty — a hitbox that
   * disagrees with what is drawn is worse than a generous one.
   */
  headRadius: 0.22,
  /** How long a downed crew member waits before returning to their seat. */
  crewRespawnSeconds: 6,
  minFireInterval: 0.03,
  /**
   * Hard ceiling on the lag compensation rewind, in seconds.
   *
   * The rewind is what makes hitscan fair between players on different
   * connections. The shooter reports its own round trip, which is not
   * trustworthy, so this bounds how much it can ask for.
   */
  maxRewindSeconds: 0.25,
  /** Vehicle state history kept for rewinding, in ticks (0.6 s at 60 Hz). */
  historyTicks: 36,
} as const;

/**
 * Repair crates (DESIGN.md §4.3, §11).
 *
 * There is NO passive regeneration. This is the only way a damaged vehicle
 * recovers, and it is deliberately a commitment: you must hold position inside
 * a small radius for several seconds, which is the most vulnerable thing a crew
 * can do. That is the whole design — repair is a risk you choose, not a timer
 * that runs in the background.
 */
export const REPAIR = {
  /** How close the vehicle must be, in metres. */
  radius: 9,
  /** At or below this speed you count as holding position, in m/s. */
  holdSpeed: 2.5,
  hullPerSecond: 110,
  componentPerSecond: 45,
  /** Seconds of repair a crate holds before it is spent. */
  capacitySeconds: 8,
  /** Seconds before a spent crate returns. */
  respawnSeconds: 45,
  /**
   * Wreck salvage (DESIGN.md §11, BR only). A destroyed car leaves a temporary,
   * contested resupply at the wreck: less charge than a real crate and a short
   * life, so it is a reward for winning a fight rather than a new landmark.
   */
  salvageSeconds: 6,
  salvageLifetimeSeconds: 40,
  /** Bound on simultaneous salvage piles, so a wipe cannot litter the map. */
  maxSalvage: 16,
} as const;

/**
 * The closing danger zone (DESIGN.md §2.2, §10.3) — solo mode only.
 *
 * The reason a last-car-standing match can be trusted to END: it forces every
 * survivor into a shrinking circle, so the final cars meet instead of circling a
 * 340 m arena forever. Unlike a hazard, the zone CAN destroy a car — that is its
 * job, not a side effect.
 *
 * Schedule is hold-then-shrink, repeated `phases` times: the radius steps from
 * `startRadius` to `endRadius` while damage outside climbs each phase.
 */
export const ZONE = {
  centreX: 0,
  centreZ: 0,
  /**
   * Safe radius when the match goes live. Just outside the 180 m solo spawn
   * ring: the MVP plays the inner part of the 800 m map, so the field meets
   * within seconds instead of crossing empty ground (shorter, denser matches).
   */
  startRadius: 210,
  /** Radius after the final shrink, and forever after. */
  endRadius: 25,
  /** Number of hold→shrink steps. Four, so the last circle lands by ~2:40. */
  phases: 4,
  /** Seconds of quiet before each shrink. */
  holdSeconds: 20,
  /** Seconds each shrink takes. */
  shrinkSeconds: 20,
  /** Hull damage per second outside, at phase 0. */
  damagePerSecond: 35,
  /** Extra damage per second added each phase, so the end is decisive. */
  damagePerPhase: 30,
} as const;

/**
 * Hazards (DESIGN.md §10.3).
 *
 * "Damaging but not instantly lethal" is a real constraint, not flavour: in a
 * crew game one driver's mistake must not instantly kill three teammates. So a
 * hazard costs hull over time and CANNOT by itself finish a vehicle — the floor
 * below stops it. What it really costs is position, which is the point.
 */
export const HAZARD = {
  /** Hull lost per second while a vehicle sits on a hazard patch. */
  hullPerSecond: 55,
  /** Hazards alone can never take a vehicle below this fraction of max hull. */
  hullFloor: 0.2,
} as const;

/**
 * Match flow (DESIGN.md §2.1, §12.1).
 *
 * A duel is a respawn team deathmatch between exactly two crews. The kill
 * target is an EARLY-WIN condition, not the normal end: with the deliberate slow
 * TTK (§6) the time limit is what usually ends a match, and that is intended.
 * See `shared/match.ts` for the state machine these numbers feed.
 *
 * Every number here is a starting point for M7's playtest, not a settled value.
 */
export const MATCH = {
  /**
   * Kill target, scaled by crew size: more gunners means kills come faster, so
   * a 4v4 needs a higher mercy number than a 2v2 to mean the same thing.
   */
  killTargetCoupe: 15,
  killTargetSuv: 25,
  /**
   * Hard regulation time for a DUEL. The clock is the normal end condition
   * there, because respawn TDM would otherwise never stop.
   */
  timeLimitSeconds: 12 * 60,
  /**
   * Solo has NO clock: last car standing means the match ends when one car is
   * left, and a timer would end it with several still driving. `0` means no
   * limit. A stalemate between the last few cars is possible until a closing
   * danger zone exists (DESIGN.md §2.2, phase 2).
   */
  soloTimeLimitSeconds: 0,
  /** Freeze between "both teams present" and "go". */
  countdownSeconds: 5,
  /** How long the results screen holds before falling back to the lobby. */
  resultsSeconds: 25,
  /** After a tied regulation, one kill wins; this is the cap if nobody scores. */
  suddenDeathSeconds: 90,
  /**
   * Seconds a destroyed crew waits before respawning TOGETHER at their team
   * spawn. The whole crew is out for this long, which is what gives a kill its
   * weight without ending anyone's match.
   */
  vehicleRespawnSeconds: 5,
  /**
   * Humans required on EACH team before the lobby will start a countdown.
   * Bots (M8) will fill seats; until then one player per team is enough.
   */
  minPlayersPerTeam: 1,
  /**
   * One-man-team mode (solo). `soloCars` is the field size — twelve, so a
   * 3–4 minute round stays busy, and a multiple of four so the spawn ring keeps
   * the arena's four-fold symmetry (fair by construction).
   * `soloMinPlayers` is the floor for a match to begin, because one car racing
   * itself is not a match.
   */
  soloCars: 12,
  soloMinPlayers: 2,
} as const;

/**
 * Ramming (DESIGN.md §3.1).
 *
 * "Impact damage scaled by relative closing velocity, capped, and both vehicles
 * take some. Passive — just physics, no button." A head-on trade hurts both
 * equally; putting your nose into someone's door hurts them much more than you.
 */
export const RAM = {
  /** Hull damage per m/s of closing speed at the contact. */
  damagePerSpeed: 9,
  /** Nudges below this closing speed (m/s) do nothing. */
  minClosingSpeed: 4,
  /** Ceiling on a single ram, so one hit can never delete a healthy car. */
  maxDamage: 450,
  /**
   * Baseline share each car keeps regardless of angle, so a head-on is not a
   * 100/0 and even a side-swipe costs the aggressor something.
   */
  baseShare: 0.45,
  /** 0 is a dead stop on contact; small values let cars glance off. */
  restitution: 0.12,
  /** Boost charge granted for ramming, per m/s of closing speed. */
  boostPerSpeed: 1.4,
} as const;

/**
 * Bots (DESIGN.md §13.9, M8).
 *
 * Server-side only — a bot is authority, not prediction, so these numbers never
 * cross the wire and the client never runs this code. Deliberately simple: the
 * first job is an opponent that drives at you and shoots, not a tactician.
 */
export const BOT = {
  /** Heading error (rad) to steer input. Higher = twitchier. */
  steerGain: 2.2,
  /**
   * Distance band the bot tries to hold. Being nose-to-nose is not the goal.
   *
   * Tried wider (55/130) for the 30-car field (M11) and REVERTED: it moved the
   * match 70.9 s → 76.9 s and the median hit range 9 → 10 m, i.e. not at all.
   * The pace is set by 30 aggressive bots all converging on their nearest enemy,
   * which is a target-selection problem, not a standoff one. Fixing it means bot
   * depth (roaming, cover, self-preservation), not a range tweak.
   */
  // (The lower bound is now `breakRange`: inside it a bot breaks off its pass.)
  maxRange: 90,
  /** How far ahead it looks for a wall, before the speed multiplier. */
  probeDistance: 16,
  /** Throttle when it has no target and is just circulating. */
  wanderThrottle: 0.5,
  /**
   * Bot depth (M11). Without these a bot beelines the globally nearest enemy
   * however far away, so a 30-car field converges into one brawl within a minute.
   *
   * `engageRadius` — only *drive at* an enemy this close. Beyond it, patrol.
   * `roamRadius` — how far from the safe centre a patrolling bot wanders, on its
   * own bearing, so the field spreads instead of stacking on the middle.
   * `retreatHull` — below this hull fraction, break off and find repair.
   */
  engageRadius: 260,
  roamRadius: 150,
  retreatHull: 0.35,
  /**
   * Target selection: prefer a target you can FINISH. A wounded enemy within
   * `finishBias` times the nearest distance is chosen over the nearest one, when
   * its hull is at or below `finishHull`. Without this a bot switches to whoever
   * is closest and a brawl grinds on with everyone on 20% hull and nobody dead.
   */
  finishHull: 0.5,
  finishBias: 1.6,
  /** It will not fire past this, metres (a sanity bound; the weapon clamps). */
  maxFireRange: 240,

  // ---- attack runs (Phase 7) ---------------------------------------------
  //
  // The solo car's main guns are fixed forward (±20°): you aim them by aiming
  // the car. The old "orbit the target at a 0.5 rad lead" kept every enemy just
  // OUTSIDE that arc, so bots sprayed at targets their guns could not point at.
  // A nose-gun car fights in PASSES instead: point at the target and close in
  // firing, break away before point-blank, open the distance, come round again.
  // The roof RPG (±135°) covers the break-away.
  /** Inside this, break off the pass (metres, × the skill's standoff). */
  breakRange: 18,
  /** While extending, turn back in once this far out (metres, × standoff). */
  reengageRange: 60,
  /** …or after this long, whichever comes first. */
  extendSeconds: 2.4,
  /** Heading off the line to the target while extending, radians (~105°). */
  extendAngle: 1.85,
  /** MG fire discipline: no bursts at targets beyond this, metres. */
  mgFireRange: 150,
  /**
   * Speed (× top speed) while inside MG range on a pass. Measured: charging in
   * at 0.8 gave ~1.5 s of firing per pass and the MGs did 9% of all damage —
   * the guns are aimed with the car, and a car at full tilt cannot hold aim.
   */
  attackSpeed: 0.6,
  /** RPG: only between these distances (splash 8 m — not at point-blank). */
  rocketMinRange: 14,
  rocketMaxRange: 150,
  /** Seconds of target-motion to lead the MG by (it is hitscan; this is the
   *  bot's reaction lag compensated, not ballistics). */
  mgLead: 0.08,
  /** Boost only when closing and roughly straight, above this charge. */
  boostAbove: 35,

  // ---- marksmanship ----------------------------------------------------
  //
  // A perfect gun makes a bot feel like a turret and ends a 16-car field in
  // seconds. These three make it miss like a person: it takes a moment to
  // react, it fires in bursts, and its tracking wanders.
  /** Seconds after acquiring a target before it will shoot. */
  reactionSeconds: 0.4,
  /**
   * Seconds of fire per burst before a pause (~11 rounds at the MG's 16/s).
   * It used to be "shots", counted per decision TICK — at 60 ticks/s against a
   * 16 rounds/s gun a "10-shot burst" was ~2.7 real rounds, and the guns ran at a
   * third of their output (measured: MGs did 9–15% of all damage).
   */
  burstSeconds: 0.7,
  /** Seconds of pause between bursts. */
  burstPause: 0.6,
  /** Radians of tracking wobble, summed from two out-of-phase sines. */
  aimWobble: 0.045,

  // ---- the danger zone -------------------------------------------------
  /** Target this fraction of the safe radius, not the edge. */
  zoneSafetyFraction: 0.7,
  /** How strongly being near the edge bends a bot back inward, 0..1 at the edge. */
  zonePull: 0.4,
} as const;

/**
 * Component damage (DESIGN.md §4.2).
 *
 * Components DISABLE rather than kill, so their health is small next to the
 * 1200-point hull: a wheel is meant to come off in a handful of hits, because
 * the decision "do I strip the tyres or go for the kill" only exists if the
 * tyres are actually reachable.
 *
 * These are tuning data, not design (DESIGN.md §14), and belong to M7's playtest.
 */
export const COMPONENT = {
  health: 120,
  /** Engine output at zero health. Not zero: the car limps instead of dying. */
  engineFloor: 0.2,
  engineTopSpeedFloor: 0.4,
  /** Traction at zero wheel health — enough to slide, not enough to steer with. */
  wheelGripFloor: 0.15,
  /** Drive at zero wheel health: no wheels, nothing to put power through. */
  wheelDriveFloor: 0,
  /**
   * How deep under the bodywork a part can be and still be credited with
   * stopping a round, in metres.
   *
   * Without this a shot through the radiator could "hit" a rear wheel on the far
   * side of the car, because the part is inside the hull box the ray passed
   * through. Parts are only reachable near the surface the round arrived at,
   * which is both truer and far easier to predict.
   */
  hitDepthTolerance: 0.6,
  /**
   * Yaw rate (rad/s) at a full left/right wheel imbalance.
   *
   * Measured, not guessed: at 0.9 a car with one wrecked side spun 2.7 rad in
   * three seconds, which is a spin rather than the "steering pull" §4.2 asks
   * for. At 0.5 it is a firm drift toward the damage that a driver can hold.
   */
  wheelPullRate: 0.5,
} as const;

export const NET = {
  /**
   * How far in the past remote vehicles are rendered, in milliseconds.
   *
   * Remote cars are drawn from buffered snapshots rather than "now", so there
   * is always a previous and a next snapshot to interpolate between. Too small
   * and a single late packet causes a visible stutter; too large and you are
   * shooting at where enemies used to be. 100 ms is the usual compromise
   * (DESIGN.md §13.4).
   */
  interpDelayMs: 100,
  /**
   * Snapshot send rate. The server always SIMULATES at TICK.rate; this only
   * controls how often state is broadcast.
   */
  snapshotRate: 30,
  /** How often the client flushes batched input to the server. */
  inputSendRate: 30,
  /**
   * Rate at which a prediction error is smoothed away (per second). Design
   * targets ~150 ms rather than a snap: vehicles are large and very visible, so
   * teleporting the local car looks broken even when the correction is correct.
   */
  correctionRate: 9,
  /** Cap on queued inputs per client, to bound the damage from a flood. */
  maxQueuedInputs: 24,
  /**
   * Interest management (DESIGN.md §13.5). A client is sent only the entities
   * within this radius of its own car — never the whole field at 60 Hz. The
   * margin is hysteresis: something already known keeps being sent until it is
   * `radius + margin` away, so a car on the boundary does not flicker in and out.
   */
  interestRadius: 320,
  interestMargin: 80,
  /**
   * If no input arrives for this long, the server assumes the player has let go
   * of the controls and applies neutral input.
   *
   * Without this, any client that stops sending — a backgrounded tab, a
   * suspended laptop, a dropped connection — leaves its car driving on its last
   * input forever, unattended. Generous enough not to fire during ordinary
   * latency or a temporary packet stall.
   */
  inputTimeoutMs: 500,
  /**
   * If nothing at all arrives from a client for this long, drop it.
   *
   * Distinct from `inputTimeoutMs`, which parks the car. This reclaims the slot:
   * a half-open connection never fires `close`, so without a liveness check a
   * dead client lingers as a ghost player forever.
   *
   * Liveness is proven by a WEBSOCKET-level ping/pong, not by app messages. A
   * backgrounded tab has its timers and animation frames throttled — or frozen
   * outright — so it can stop sending for far longer than this, but the browser's
   * network stack still answers protocol pings. Reaping on app silence is what
   * disconnected a player who simply switched tabs.
   */
  clientTimeoutMs: 20_000,
  /**
   * How often the server pings each socket. Must be comfortably below
   * `clientTimeoutMs` so a live-but-quiet client is never mistaken for dead.
   */
  heartbeatMs: 5_000,
} as const;

/**
 * Vehicle classes.
 *
 * Two genuinely different vehicles, not one shape at two sizes: a low two-seat
 * coupe and a tall four-seat SUV. Dimensions live here rather than in `VEHICLE`
 * because collision, ground sampling and the wheel layout all read them, and the
 * two classes must never share a collider — a visually larger SUV hit-tested as
 * a coupe is immediately obvious to players in a shooter.
 *
 * Handling TUNING (engine force, grip, boost) stays shared: the classes never
 * meet in a match (separate playlists, DESIGN.md §2), so there is nothing to be
 * unfair about, and one tuning surface is far easier to reason about.
 */
export type VehicleClassId = 'coupe' | 'suv' | 'solo';

export type VehicleSpec = {
  id: VehicleClassId;
  label: string;
  /** Half-extent of the chassis collision box, left-right (metres). */
  halfWidth: number;
  /** Half-extent of the chassis collision box, front-back (metres). */
  halfLength: number;
  /** Chassis collision box height. Wheels hang below this. */
  boxHeight: number;
  wheelRadius: number;
  /** Chassis centre height above the ground when at rest. */
  rideHeight: number;
  /** Left-right wheel spacing. */
  track: number;
  /** Front-rear wheel spacing. */
  wheelbase: number;
};

export const VEHICLE_CLASSES: Record<VehicleClassId, VehicleSpec> = {
  /**
   * Modern two-seat coupe: low and wide, cabin set back over the rear axle.
   * `boxHeight` deliberately wraps the greenhouse rather than just the hull, so
   * the roof cannot visually clip through geometry the collider ignores.
   */
  coupe: {
    id: 'coupe',
    label: 'Coupe',
    halfWidth: 0.93,
    halfLength: 2.15,
    boxHeight: 1.28,
    wheelRadius: 0.35,
    rideHeight: 0.72,
    track: 1.62,
    wheelbase: 2.62,
  },
  /** Four-seat SUV: tall and boxy, two rows of windows and seats for the crew. */
  suv: {
    id: 'suv',
    label: 'SUV',
    halfWidth: 1.0,
    halfLength: 2.45,
    boxHeight: 1.85,
    wheelRadius: 0.45,
    rideHeight: 1.05,
    track: 1.72,
    wheelbase: 2.95,
  },
  /**
   * One-man-team brawler: a 2-seat armoured muscle car (see DESIGN.md §2.3).
   * There is nobody else in it, so there are no windows to shoot from — the guns
   * are bolted to the car, and the driver works them. Team modes keep the bigger
   * vehicles, which have seats for gunners.
   *
   * Real-world sized from its model (`scripts/prep/brawler.ts`): 4.9 m long,
   * 1.51 m track, 2.74 m wheelbase — a little narrower and lower than the SUV.
   */
  solo: {
    id: 'solo',
    label: 'Brawler',
    halfWidth: 0.97,
    halfLength: 2.45,
    boxHeight: 1.2,
    wheelRadius: 0.351,
    rideHeight: 0.78,
    track: 1.51,
    wheelbase: 2.74,
  },
};

export const DEFAULT_VEHICLE_CLASS: VehicleClassId = 'suv';

export const VEHICLE = {
  // ------------------------------------------------------------------ drive
  gravity: -30,
  /**
   * Acceleration at full throttle, on the ground (m/s²).
   *
   * Tuned for CONTROL, not for reaching the top speed as fast as possible.
   * This started at 31 m/s² — 3.2 g — which hit 100 km/h in about a second and
   * felt like the throttle was an on/off switch with no driver input. It now
   * gives roughly 0–100 km/h in 3.5 s and top speed in about 5.5 s: quick
   * enough to feel arcade, slow enough that the driver is making decisions.
   *
   * NOTE: terminal velocity under linear rolling resistance is
   * `engineForce / rollingResistance`. That MUST exceed `maxSpeed`, or the car
   * tops out below its stated limit and the top-speed clamp never engages.
   * 9.5 / 0.12 ≈ 79 m/s, comfortably above 40.
   */
  engineForce: 9.5,
  reverseForce: 5.5,
  /** Applied when throttle opposes current motion. */
  brakeForce: 12,
  maxSpeed: 40, // m/s ≈ 144 km/h
  maxReverseSpeed: 10,
  /** Linear damping applied at all times (dv/dt = -rollingResistance · v). */
  rollingResistance: 0.12,

  /**
   * Throttle below this counts as released.
   *
   * Analogue inputs approach zero asymptotically — exponential smoothing in the
   * input layer never actually reaches it — so a "released" throttle arrives as
   * something like 1e-27. That is not zero, so the simulation took the throttle
   * branch and engine braking never engaged: the car coasted on rolling
   * resistance alone, apparently forever. Any threshold check on an analogue
   * axis needs a deadzone.
   */
  throttleDeadzone: 0.01,

  /**
   * Engine braking: constant deceleration (m/s²) applied when the driver is not
   * asking for throttle or reverse, so the car slows and comes to a stop rather
   * than coasting on almost indefinitely.
   *
   * The design intent (playtest feedback): the car should only be moving while
   * the drive/reverse input is held. Lift off and it decelerates to a halt.
   */
  engineBraking: 9,

  /**
   * Longitudinal braking applied by the handbrake.
   *
   * MUST exceed `engineBraking` — the handbrake has to be the strongest thing
   * the driver can do, and an early version was weaker than simply lifting off,
   * which made pulling it actively counter-productive.
   */
  handbrakeBraking: 13,

  /**
   * How much of `handbrakeBraking` fades out at full speed (0..1).
   *
   * This is what makes drifting possible. With a constant 13 m/s² the car
   * scrubbed from 79 km/h to 20 in about a second and the slide was over before
   * it began. Braking now falls off with speed so a slide carries momentum, and
   * returns to full strength as the car slows so the handbrake still stops it.
   */
  handbrakeBrakingFalloff: 0.78,

  /**
   * Fraction of engine force that still reaches the ground while the handbrake
   * is held. High enough that throttle can sustain a drift; low enough that
   * holding it from a standstill does nothing (the handbrake wins at low speed).
   */
  handbrakeDriveFactor: 0.65,

  /**
   * Steering authority multiplier while handbraking, so pulling it rotates the
   * car decisively rather than merely reducing grip.
   */
  handbrakeSteerBonus: 1.35,
  /** Quadratic air drag. */
  drag: 0.0016,

  // --------------------------------------------------------------- steering
  /** Yaw rate at full lock and full steering authority (rad/s). */
  steerRate: 2.4,
  /** How quickly steering authority falls off with speed. */
  steerSpeedFalloff: 0.03,
  minSteerFactor: 0.34,
  /** Speed at which steering reaches full authority. */
  steerEngageSpeed: 4,
  /** Steering authority multiplier while airborne. */
  airSteerFactor: 0.12,

  // ------------------------------------------------------------ grip / drift
  /** Rate at which lateral velocity is killed (per second). Higher = more grip. */
  lateralGrip: 10.5,
  /**
   * Lateral grip while the handbrake is held. Lower = longer, floatier drifts.
   *
   * This is the main lever on how much speed a drift costs: lateral grip is
   * where a slide's energy is dissipated, so a higher value scrubs momentum
   * faster and makes the slide feel like braking rather than drifting.
   */
  lateralGripHandbrake: 0.6,

  // -------------------------------------------------------- ground following
  /** How far above rest height the chassis can sit and still count as grounded. */
  groundStick: 0.3,
  /** Upper bound on the vertical speed terrain can impart (ramp launches). */
  maxClimbRate: 22,
  /** Height the car can step up without leaving the ground. */
  stepUp: 0.45,

  // ----------------------------------------------------- chassis attitude (visual)
  /** Largest pitch/roll angle applied to the chassis, in radians. */
  maxAttitude: 0.6,
  /** How fast the chassis attitude chases the ground or flight angle (per second). */
  attitudeRate: 8,
  /**
   * A wheel only counts as touching if it is within this distance of the highest
   * contact. Stops a wheel hanging over a drop from dragging the nose down.
   */
  wheelContactTolerance: 1.2,

  // ------------------------------------------------------------------ boost
  boost: {
    max: 100,
    start: 50,
    drainPerSecond: 34,
    /** Top-speed multiplier while boosting. */
    multiplier: 1.6,
    /**
     * Acceleration multiplier while boosting. Raised from 1.5 when engine force
     * dropped: boost has to still feel like a shove, and 1.5× of a gentler
     * engine was barely noticeable.
     */
    forceMultiplier: 2.5,
    /** Boost gained per second at maximum speed (momentum). */
    gainPerSecondAtFullSpeed: 9,
    /** Boost gained per ram impact (aggression). Wired up in M5. */
    gainPerImpact: 20,
    minSpeedForGain: 10,
  },
} as const;

export const CAMERA = {
  /** Distance from the car at the default orbit angle. */
  distance: 8.2,
  /** Extra height added on top of the orbit maths. */
  height: 2.4,
  /** Default downward pitch. */
  pitch: 0.17,
  minPitch: -0.35,
  maxPitch: 0.85,
  /**
   * Heading smoothing rate (per second). Lower = the camera lags further behind
   * the car's rotation, which makes a drift read as the car swinging out rather
   * than the whole world turning. Too low feels disconnected while cornering.
   */
  follow: 8,
  /** Camera height to look at, above the car's centre. */
  lookAtHeight: 1.0,
  sensitivity: 0.0022,
  fov: 74,
  /** FOV added at top speed, for a sense of velocity. */
  speedFovGain: 10,

  /**
   * The solo brawler's camera: a view FORWARD of the car, aligned to the gun.
   *
   * The chase camera is a view OF the car, so its screen centre is the car —
   * useless for aiming (it is the same reason the gunner got a window camera in
   * M5). But a solo driver still has to drive, so this is a third-person view
   * that sits behind and above and looks where the gun points: the car stays in
   * frame, and the crosshair is the world.
   */
  // Sized for the brawler (1.4 m tall plus a 0.5 m roof station): the sight
  // line clears the station, so the crosshair is never on it.
  soloDistance: 7.2,
  soloHeight: 2.7,
  /** How far ahead the camera looks. Larger flattens the aim feel. */
  soloLookAhead: 26,
  /**
   * Height (above the car's centre) of the point the solo camera looks at, at
   * neutral pitch. Close to the camera's own height, so a level mouse means a
   * level shot: at 0.6 m the crosshair met the road ~35 m ahead and a "straight"
   * rocket hit the ground in front of you.
   */
  soloAimHeight: 2.0,
  /** Solo camera position follow rate (1/s). Higher is stiffer; aim is never smoothed. */
  soloFollow: 14,
} as const;

/**
 * Arena palette.
 *
 * These are LIT colours — kept mid-tone rather than near-black, because the
 * first pass rendered almost pure black once ACES tone mapping compressed the
 * shadows, and you cannot drive a car on ground you can't see.
 */
export const PALETTE = {
  floor: 0xffffff, // the floor's look comes from its grid texture
  wall: 0x5f6874,
  ramp: 0x6f7885, // was too bright at first pass; ramps glowed white
  block: 0x59636f,
  pad: 0x5f7d69,
  /** Hazard zone. Flat and drivable now; damaging from M6. */
  hazard: 0x7a4234,

  /**
   * Zone ground tints (M10/M11). Nested floor rings, each a little higher than
   * the last so the innermost wins without z-fighting, tint the ground by zone so
   * the map reads as places rather than one grey field. Muted on purpose — these
   * are tinted by the grid texture, not flat fills.
   */
  zoneCentre: 0x9aa2ad,
  zoneDunes: 0xa79b7f,
  zoneScrapyard: 0x8f9c8e,
  zoneLakebed: 0x93a3b3,
  zoneRim: 0x7d8794,

  /**
   * Authored map (M12 map pass). A road is a ground strip on the axes, so a
   * quarter turn turns one segment into a ring road and four spokes; the
   * plateau is the one piece of drivable high ground; `landmark` is the taller,
   * navigable structures (the scrapyard crane).
   */
  road: 0x454b54,
  plateau: 0x6a727e,
  landmark: 0x71808f,
} as const;

/** Environment colours, shared for consistency between scene and fog. */

/**
 * Feel of speed (Phase 8): camera, motion cues and sound that make 40 m/s read
 * as fast. All client-side and cosmetic; none of it touches the simulation.
 */
export const FEEL = {
  camera: {
    /** Extra FOV while boosting, on top of `CAMERA.speedFovGain`. */
    boostFov: 7,
    /** Metres the camera falls back per m/s² of acceleration (forward on braking). */
    accelLag: 0.045,
    /** Clamp on that fall-back / push-in, metres. */
    accelLagMax: 1.1,
    /** Positional shake at top speed, metres (× 1.8 off-road, × 1.6 boosting). */
    speedShake: 0.035,
    /** Downward jolt on landing, metres per m/s of fall speed. */
    landingJolt: 0.06,
  },
  dust: {
    /** Puffs per second per wheel at top speed on dirt. */
    rate: 26,
    /** Tyre smoke on hard ground once slip passes this, m/s. */
    smokeSlip: 4,
  },
  sound: {
    /** Gear tops, m/s: the engine note climbs through each and drops at a shift. */
    gears: [11, 20, 29, 38, 48, 64] as const,
  },
} as const;

/**
 * Visible damage (client/damageFx.ts). `stages` are the damage (1 − hull
 * fraction) at which a car turns scuffed, smoking, critical (flames) and
 * burning; rates are particles per second at the first stage and at death.
 */
export const DAMAGE_FX = {
  stages: [0.25, 0.5, 0.75, 0.9] as const,
  smokeRate: [3, 26] as const,
  fireRate: [18, 70] as const,
  smokeCapacity: 700,
  fireCapacity: 400,
  emberCapacity: 260,
  /** Point lights shared by the fires nearest the camera; fixed, never added at runtime. */
  fireLights: 1,
  fireLightIntensity: 34,
  /** Seconds a wreck keeps burning where the car died. */
  wreckBurn: 9,
  /** How far toward soot a dying car's paint goes (0..1). */
  maxScorch: 0.7,
} as const;

/**
 * Lighting presets: the sky, the lights and the post-process of one MAP's time
 * of day. A map picks one (`MAP_LIGHTING`); a second map — dusk, overcast day,
 * a blackout — is a new entry here plus its HDRI, not new code.
 *
 * The environment is a real HDRI (image-based light and reflections); the key is
 * one bank of floodlights (it casts the shadows) and the fills are the other
 * corner banks, so no face of a car or container goes black (client/lighting.ts).
 */
export type LightingPreset = {
  /** Poly Haven HDRI under public/assets/hdri/ (credited in assets.json). */
  hdri: string;
  exposure: number;
  environmentIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  keyColour: number;
  keyIntensity: number;
  /** Key light position relative to the view, metres: high and off one corner. */
  keyOffset: readonly [number, number, number];
  fillColour: number;
  fillIntensity: number;
  bloomStrength: number;
  bloomRadius: number;
  /** Only genuinely bright things bloom (lamps, LEDs, flashes, fire). */
  bloomThreshold: number;
  /**
   * The visible sky. `skyBottom` is deliberately the FOG colour, so the dome
   * meets the fogged horizon without a seam; `skyTop` is a darker zenith.
   */
  sky: {
    background: number;
    fog: number;
    skyTop: number;
    skyBottom: number;
    fogNear: number;
    fogFar: number;
  };
};

export const LIGHTING_PRESETS = {
  /**
   * The stadium at night: a dark sky, the floor lit by the floodlights and not
   * much else. The first pass was closer to dusk; this is properly night, so
   * the LEDs, muzzle flashes and burning cars carry the frame.
   */
  floodlitNight: {
    hdri: 'satara_night_1k.hdr',
    exposure: 0.85,
    environmentIntensity: 0.45,
    hemiSky: 0x55668c,
    hemiGround: 0x1e1a16,
    hemiIntensity: 0.4,
    keyColour: 0xfff1de,
    keyIntensity: 2.3,
    keyOffset: [-70, 120, -50],
    fillColour: 0xdfe6ff,
    fillIntensity: 0.7,
    bloomStrength: 0.5,
    bloomRadius: 0.45,
    bloomThreshold: 1.05,
    sky: {
      background: 0x141a26,
      fog: 0x141a26,
      skyTop: 0x070a10,
      skyBottom: 0x141a26,
      // Fog that ends inside the arena hides the playfield rather than the
      // horizon, so it has to reach past the stands.
      fogNear: 300,
      fogFar: 820,
    },
  },
} as const satisfies Record<string, LightingPreset>;

/** The current (only) map's preset. */
export const MAP_LIGHTING: keyof typeof LIGHTING_PRESETS = 'floodlitNight';
export const LIGHTING: LightingPreset = LIGHTING_PRESETS[MAP_LIGHTING];
export const SKY = LIGHTING.sky;
