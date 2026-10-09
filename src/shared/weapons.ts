/**
 * Weapons.
 *
 * Personal arms, carried by players and fired out of a vehicle window (DESIGN.md
 * §3.2), and the weapons bolted to a solo car (`mg`, `rocket`), each on its own
 * trigger (see `MountedWeapon` in crews.ts).
 *
 * Shared because both sides need them and they must not disagree: the client
 * predicts and renders with these numbers, and the server validates every shot
 * against them. A rate of fire the client believes is 8/s and the server believes
 * is 6/s is a client that feels cheated every time it pulls the trigger.
 *
 * `delivery` is the important fork: hitscan is resolved instantly and needs lag
 * compensation, projectiles are simulated and need replication.
 */

export type WeaponId = 'rifle' | 'marksman' | 'launcher' | 'mg' | 'rocket';

export type WeaponDef = {
  id: WeaponId;
  name: string;
  /** Hitscan resolves instantly; projectile travels and can be dodged. */
  delivery: 'hitscan' | 'projectile';
  /** Damage on a direct hit. */
  damage: number;
  /** Shots per second. The server enforces this; the client only predicts it. */
  rate: number;
  magazine: number;
  reloadSeconds: number;
  /**
   * Cone half-angle in radians, applied to each shot.
   *
   * Spread rather than recoil: with a reticle-ray aim model, spread is what makes
   * sustained fire a decision instead of a laser.
   */
  spread: number;
  /** Hitscan: maximum range in metres. Projectile: ignored. */
  range: number;
  /** Projectile: muzzle speed in m/s. */
  speed: number;
  /** Projectile: splash damage radius in metres, 0 for none. */
  splash: number;
  automatic: boolean;
};

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: {
    id: 'rifle',
    name: 'Rifle',
    delivery: 'hitscan',
    damage: 17,
    rate: 9,
    magazine: 30,
    reloadSeconds: 2.2,
    spread: 0.014,
    range: 220,
    speed: 0,
    splash: 0,
    automatic: true,
  },
  marksman: {
    id: 'marksman',
    name: 'Marksman',
    delivery: 'hitscan',
    damage: 52,
    rate: 1.3,
    magazine: 6,
    reloadSeconds: 3,
    spread: 0.002,
    range: 320,
    speed: 0,
    splash: 0,
    automatic: false,
  },
  /**
   * Twin bumper machine guns (the solo armoured truck's primary). Each shot is
   * one round from the next barrel in turn, so 16/s is 8 per gun — a steady,
   * readable stream rather than a laser. Low per-round damage: this is the weapon
   * you keep on target, not the one that ends the fight.
   */
  mg: {
    id: 'mg',
    name: 'Twin .50',
    delivery: 'hitscan',
    // 9 → 11 (Phase 7): with bots finally able to aim, the MGs did 23% of all
    // damage and the RPG 47% — the main weapon was the support act.
    damage: 11,
    rate: 16,
    magazine: 160,
    reloadSeconds: 2.8,
    spread: 0.011,
    range: 230,
    speed: 0,
    splash: 0,
    automatic: true,
  },
  /**
   * The roof RPG (the truck's secondary, right-click). One heavy round, a
   * visible flight, a big splash, and a reload long enough that missing costs.
   */
  rocket: {
    id: 'rocket',
    name: 'RPG',
    delivery: 'projectile',
    // 240 → 200 (Phase 7, see the MG): still a sixth of a hull per direct hit.
    damage: 200,
    rate: 0.5,
    magazine: 1,
    reloadSeconds: 3.2,
    spread: 0.003,
    range: 320,
    speed: 78,
    splash: 8,
    automatic: false,
  },
  launcher: {
    id: 'launcher',
    name: 'Launcher',
    delivery: 'projectile',
    damage: 85,
    rate: 0.8,
    magazine: 1,
    reloadSeconds: 3.4,
    spread: 0.004,
    range: 300,
    speed: 48,
    splash: 6,
    automatic: false,
  },
};

/** Slot order a player cycles through. Slot 0 is what they spawn holding. */
export const DEFAULT_LOADOUT: WeaponId[] = ['rifle', 'launcher'];

export const MAX_WEAPONS = 3;

/** Seconds between shots. Derived, so rate and cooldown can never disagree. */
export const fireInterval = (weapon: WeaponDef): number => 1 / weapon.rate;

/**
 * The server's rate limit, as a schedule: a shot is accepted from `jitter` of
 * an interval BEFORE it is due, and the next one becomes due an interval after
 * the later of now and this one's due time. Returns the next due time, or null
 * if the shot is too early.
 *
 * "Now minus last shot ≥ interval" rejected shots a client sent exactly on time
 * whenever network jitter bunched two of them; the schedule absorbs that while
 * still holding the AVERAGE rate to the weapon's (at most one early shot banked).
 */
export function scheduleShot(due: number, now: number, interval: number, jitter: number): number | null {
  if (now < due - interval * jitter) return null;
  return Math.max(now, due) + interval;
}

export type AmmoState = {
  /**
   * Index into the player's loadout: the weapon a window gunner is HOLDING.
   * Car-mounted weapons ignore it — each has its own trigger and fires by slot.
   */
  slot: number;
  /** Rounds left in each magazine, by slot. */
  rounds: number[];
  /**
   * Seconds remaining in each slot's reload, or 0. Per slot because mounted
   * weapons reload independently: the RPG reloading must not stop the guns.
   */
  reload: number[];
};

export function createAmmoState(loadout: WeaponId[] = DEFAULT_LOADOUT): AmmoState {
  return {
    slot: 0,
    rounds: loadout.map((id) => WEAPONS[id].magazine),
    reload: loadout.map(() => 0),
  };
}

export function weaponInSlot(loadout: WeaponId[], slot: number): WeaponDef {
  return WEAPONS[loadout[slot] ?? loadout[0]];
}
