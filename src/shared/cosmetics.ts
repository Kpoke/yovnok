/**
 * Cosmetics (M12): paint, wheels and roof kits — every one of them **purely
 * visual**. Nothing in this file is read by the simulation, so a cosmetic can
 * never change handling, damage or speed. That property is the point of a
 * cosmetic-only shop (DESIGN.md §14): the only thing money or playtime can buy
 * is how the car looks.
 *
 * A `look` is deliberately three small indices, not a bag of colours, because it
 * has to cross the wire once per vehicle per snapshot (see `packLook`). The
 * catalogue lives here where both sides can see it; the client resolves an index
 * to geometry and paint, the server only relays the number.
 *
 * Unlocks are earned, not bought, at M12. Accounts are M13, so progression lives
 * in a local profile (`client/profile.ts`) and is client-authoritative on
 * purpose: there is nothing to cheat for.
 */

import { GUNNER_PRIMARIES, GUNNER_SECONDARY, PRIMARIES, SECONDARIES, type WeaponId } from './weapons';

export type Finish = 'gloss' | 'matte' | 'chrome' | 'pearl';

/** How a cosmetic is earned. Rules are evaluated against a local profile. */
export type UnlockRule =
  | { type: 'default' }
  | { type: 'matches'; n: number }
  | { type: 'kills'; n: number }
  | { type: 'wins'; n: number };

export type Livery = {
  id: string;
  name: string;
  /** Base body colour. */
  body: number;
  finish: Finish;
  unlock: UnlockRule;
};

export type WheelStyle = {
  id: string;
  name: string;
  /** Spoke count. Zero is a plain steel wheel with no spokes. */
  spokes: number;
  /** Rim and spoke colour. Tyre stays black. */
  hub: number;
  unlock: UnlockRule;
};

export type RoofKind = 'none' | 'rack' | 'wing' | 'scoop' | 'lights' | 'bullbar' | 'armour' | 'exhaust';

export type RoofKit = {
  id: string;
  name: string;
  kind: RoofKind;
  unlock: UnlockRule;
};

/**
 * Livery catalogue. First entry is the default a new player starts with, and the
 * finish column is what makes them read as different materials rather than just
 * different hues — matte, pearl and chrome are their own purchases.
 */
export const LIVERIES: readonly Livery[] = [
  { id: 'factory', name: 'Factory Orange', body: 0xff8a3d, finish: 'gloss', unlock: { type: 'default' } },
  { id: 'midnight', name: 'Midnight', body: 0x243447, finish: 'gloss', unlock: { type: 'default' } },
  { id: 'ivory', name: 'Ivory', body: 0xe8e2d4, finish: 'gloss', unlock: { type: 'default' } },
  { id: 'cyan', name: 'Cyan', body: 0x4fd1ff, finish: 'gloss', unlock: { type: 'default' } },
  { id: 'signal', name: 'Signal Red', body: 0xe0453a, finish: 'gloss', unlock: { type: 'matches', n: 3 } },
  { id: 'racing', name: 'Racing Green', body: 0x2f6b4f, finish: 'gloss', unlock: { type: 'matches', n: 5 } },
  { id: 'matte', name: 'Matte Black', body: 0x1b1e23, finish: 'matte', unlock: { type: 'matches', n: 8 } },
  { id: 'sunburst', name: 'Sunburst', body: 0xffc542, finish: 'gloss', unlock: { type: 'kills', n: 15 } },
  { id: 'pearl', name: 'Pearl White', body: 0xf2f4f7, finish: 'pearl', unlock: { type: 'wins', n: 1 } },
  { id: 'chrome', name: 'Chrome', body: 0xdfe6ee, finish: 'chrome', unlock: { type: 'kills', n: 50 } },
];

/**
 * Rim colours. The realistic wheel is one textured model; the rim is painted
 * in the shader inside the tyre's radius (gltfPartLibrary). Factory keeps the
 * model's own finish.
 */
export const WHEELS: readonly WheelStyle[] = [
  { id: 'factory', name: 'Factory', spokes: 5, hub: 0xa7b0bb, unlock: { type: 'default' } },
  { id: 'black', name: 'Black', spokes: 5, hub: 0x1a1c20, unlock: { type: 'default' } },
  { id: 'gunmetal', name: 'Gunmetal', spokes: 5, hub: 0x50565e, unlock: { type: 'matches', n: 4 } },
  { id: 'red', name: 'Red', spokes: 5, hub: 0xc8302a, unlock: { type: 'kills', n: 10 } },
  { id: 'bronze', name: 'Bronze', spokes: 5, hub: 0xb07a3a, unlock: { type: 'matches', n: 12 } },
  { id: 'gold', name: 'Gold', spokes: 5, hub: 0xe8c35a, unlock: { type: 'kills', n: 25 } },
  { id: 'white', name: 'White', spokes: 5, hub: 0xeeeeea, unlock: { type: 'wins', n: 1 } },
];

/** Body kits, bolted on (client/vehicle/bodyKits.ts). Looks only. */
export const ROOFS: readonly RoofKit[] = [
  { id: 'clean', name: 'Clean', kind: 'none', unlock: { type: 'default' } },
  { id: 'bullbar', name: 'Bull Bar', kind: 'bullbar', unlock: { type: 'default' } },
  { id: 'lights', name: 'Light Bar', kind: 'lights', unlock: { type: 'matches', n: 3 } },
  { id: 'wing', name: 'Rear Wing', kind: 'wing', unlock: { type: 'kills', n: 15 } },
  { id: 'armour', name: 'Side Armour', kind: 'armour', unlock: { type: 'matches', n: 12 } },
  { id: 'exhaust', name: 'Side Exhausts', kind: 'exhaust', unlock: { type: 'wins', n: 1 } },
];

/** Door decals; the number (if any) is painted inside the roundel. */
export const DECALS: readonly { id: string; name: string; unlock: UnlockRule }[] = [
  { id: 'none', name: 'None', unlock: { type: 'default' } },
  { id: 'roundel', name: 'Race Number', unlock: { type: 'default' } },
  { id: 'flames', name: 'Flames', unlock: { type: 'matches', n: 5 } },
  { id: 'bolt', name: 'Lightning', unlock: { type: 'kills', n: 8 } },
  { id: 'skull', name: 'Skull', unlock: { type: 'kills', n: 30 } },
  { id: 'star', name: 'Star', unlock: { type: 'wins', n: 1 } },
];

/** A paint pattern over the livery, in the accent colour (drawn in the paint shader). */
export type PatternKind = 'none' | 'stripes' | 'hazard' | 'tiger' | 'camo' | 'checker';
export type Pattern = { id: PatternKind; name: string; unlock: UnlockRule };

export const PATTERNS: readonly Pattern[] = [
  { id: 'none', name: 'Plain', unlock: { type: 'default' } },
  { id: 'stripes', name: 'Racing Stripes', unlock: { type: 'default' } },
  { id: 'hazard', name: 'Hazard', unlock: { type: 'matches', n: 2 } },
  { id: 'camo', name: 'Camo', unlock: { type: 'matches', n: 6 } },
  { id: 'tiger', name: 'Tiger', unlock: { type: 'kills', n: 10 } },
  { id: 'checker', name: 'Checker', unlock: { type: 'wins', n: 1 } },
];

/** Accent colours: the pattern's paint. */
export const ACCENTS: readonly { name: string; colour: number }[] = [
  { name: 'Black', colour: 0x15171b },
  { name: 'White', colour: 0xf2f2ee },
  { name: 'Orange', colour: 0xff8a3d },
  { name: 'Red', colour: 0xd8342c },
  { name: 'Yellow', colour: 0xf5c400 },
  { name: 'Cyan', colour: 0x2cc8f0 },
  { name: 'Lime', colour: 0x8fd630 },
  { name: 'Purple', colour: 0x7a4bd6 },
];

/** Underglow: a neon light under the car (0 = off). */
export const GLOWS: readonly { name: string; colour: number; unlock: UnlockRule }[] = [
  { name: 'Off', colour: 0, unlock: { type: 'default' } },
  { name: 'Orange', colour: 0xff7a1f, unlock: { type: 'matches', n: 1 } },
  { name: 'Cyan', colour: 0x22d8ff, unlock: { type: 'kills', n: 5 } },
  { name: 'Magenta', colour: 0xff2fd0, unlock: { type: 'matches', n: 10 } },
  { name: 'Lime', colour: 0x7dff3a, unlock: { type: 'kills', n: 25 } },
  { name: 'White', colour: 0xf4f8ff, unlock: { type: 'wins', n: 1 } },
];

/**
 * What the people in the car wear (team formats' gunners, and every driver).
 * Each is a model (`public/assets/characters/<id>/figure.glb`); the livery
 * colour tints its kit.
 */
export const OUTFITS: readonly { id: 'swat' | 'mechanic' | 'soldier'; name: string; unlock: UnlockRule }[] = [
  { id: 'swat', name: 'SWAT', unlock: { type: 'default' } },
  { id: 'mechanic', name: 'Mechanic', unlock: { type: 'default' } },
  { id: 'soldier', name: 'Soldier', unlock: { type: 'matches', n: 3 } },
];
export type OutfitId = (typeof OUTFITS)[number]['id'];

export type CosmeticLook = {
  /** Index into `LIVERIES`. */
  livery: number;
  /** Index into `WHEELS`. */
  wheels: number;
  /** Index into `ROOFS`. */
  roof: number;
  /** Index into `PATTERNS`. */
  pattern: number;
  /** Index into `ACCENTS`. */
  accent: number;
  /** Index into `GLOWS`. */
  glow: number;
  /**
   * The car's guns: indices into `PRIMARIES` and `SECONDARIES` (weapons.ts).
   * Not cosmetic — the server arms the car from these — but carried in the look
   * so every page draws the guns the car really has.
   */
  primary: number;
  secondary: number;
  /** Index into `DECALS`. */
  decal: number;
  /** Race number on the doors, 0 = none, else 1–99. */
  number: number;
  /** A window gunner's primary: index into `GUNNER_PRIMARIES` (team formats). */
  gunner: number;
  /** Index into `OUTFITS`. */
  outfit: number;
};

export const DEFAULT_LOOK: CosmeticLook = {
  livery: 0,
  wheels: 0,
  roof: 0,
  pattern: 0,
  accent: 0,
  glow: 0,
  primary: 0,
  secondary: 0,
  decal: 0,
  number: 0,
  gunner: 0,
  outfit: 0,
};

/** Clamp every index into range, so a stale profile cannot crash a render. */
export function clampLook(look: Partial<CosmeticLook>): CosmeticLook {
  return {
    livery: clampIndex(look.livery ?? 0, LIVERIES.length),
    wheels: clampIndex(look.wheels ?? 0, WHEELS.length),
    roof: clampIndex(look.roof ?? 0, ROOFS.length),
    pattern: clampIndex(look.pattern ?? 0, PATTERNS.length),
    accent: clampIndex(look.accent ?? 0, ACCENTS.length),
    glow: clampIndex(look.glow ?? 0, GLOWS.length),
    primary: clampIndex(look.primary ?? 0, PRIMARIES.length),
    secondary: clampIndex(look.secondary ?? 0, SECONDARIES.length),
    decal: clampIndex(look.decal ?? 0, DECALS.length),
    number: clampIndex(look.number ?? 0, 100),
    gunner: clampIndex(look.gunner ?? 0, GUNNER_PRIMARIES.length),
    outfit: clampIndex(look.outfit ?? 0, OUTFITS.length),
  };
}

/** A window gunner's personal weapons: the chosen primary and the launcher. */
export function gunnerLoadoutOf(look: CosmeticLook): WeaponId[] {
  return [GUNNER_PRIMARIES[clampLook(look).gunner], GUNNER_SECONDARY];
}

/** The guns a look arms the car with: [primary, secondary]. */
export function loadoutOf(look: CosmeticLook): WeaponId[] {
  const l = clampLook(look);
  return [PRIMARIES[l.primary], SECONDARIES[l.secondary]];
}

function clampIndex(v: number, length: number): number {
  if (!Number.isFinite(v)) return 0;
  const i = Math.floor(v);
  return i < 0 ? 0 : i >= length ? length - 1 : i;
}

/** Above the low 32 bits: arithmetic, not bit operations (those are 32-bit). */
const HIGH = 2 ** 32;

/**
 * Pack a look into one number for the wire — many fields per vehicle per tick
 * would be many fields in the hottest message in the game; one is enough:
 *
 *   bits 0–7 livery · 8–11 wheels · 12–15 roof · 16–19 pattern · 20–23 accent
 *   24–26 underglow · 27–28 primary gun · 29–30 secondary gun
 *   above 2^32: decal (4 bits), race number (7), gunner's gun (2), outfit (3)
 */
export function packLook(look: Partial<CosmeticLook>): number {
  const l = clampLook(look);
  const low =
    ((l.livery & 0xff) |
      ((l.wheels & 0xf) << 8) |
      ((l.roof & 0xf) << 12) |
      ((l.pattern & 0xf) << 16) |
      ((l.accent & 0xf) << 20) |
      ((l.glow & 0x7) << 24) |
      ((l.primary & 0x3) << 27) |
      ((l.secondary & 0x3) << 29)) >>>
    0;
  const high = (l.decal & 0xf) | ((l.number & 0x7f) << 4) | ((l.gunner & 0x3) << 11) | ((l.outfit & 0x7) << 13);
  return low + high * HIGH;
}

export function unpackLook(packed: number): CosmeticLook {
  const whole = Number.isFinite(packed) && packed >= 0 ? Math.floor(packed) : 0;
  const n = whole % HIGH;
  const high = Math.floor(whole / HIGH);
  return clampLook({
    decal: high & 0xf,
    number: (high >> 4) & 0x7f,
    gunner: (high >> 11) & 0x3,
    outfit: (high >> 13) & 0x7,
    livery: n & 0xff,
    wheels: (n >> 8) & 0xf,
    roof: (n >> 12) & 0xf,
    pattern: (n >> 16) & 0xf,
    accent: (n >> 20) & 0xf,
    glow: (n >> 24) & 0x7,
    primary: (n >> 27) & 0x3,
    secondary: (n >> 29) & 0x3,
  });
}

/**
 * A deterministic look for a bot, so a 30-car field is varied rather than all
 * one colour. Bots ignore unlocks: they are the field, not customers.
 */
export function botLook(id: number): CosmeticLook {
  const a = Math.abs(id);
  return clampLook({
    livery: a % LIVERIES.length,
    wheels: (a * 3) % WHEELS.length,
    roof: (a * 5 + 1) % ROOFS.length,
    decal: a % 2 === 0 ? 1 : (a * 3) % DECALS.length,
    number: ((a * 37) % 98) + 1,
    gunner: (a * 5) % GUNNER_PRIMARIES.length,
    outfit: (a * 7 + 2) % OUTFITS.length,
    // Some bots wear a pattern; guns vary too, so the field is not all MGs.
    pattern: a % 3 === 0 ? 0 : (a * 7 + 1) % PATTERNS.length,
    accent: (a * 5 + 2) % ACCENTS.length,
    glow: a % 4 === 1 ? (a % (GLOWS.length - 1)) + 1 : 0,
    primary: (a * 7 + 3) % PRIMARIES.length,
    secondary: Math.floor(a / 3) % 2,
  });
}

/** The local, per-browser progression record (accounts land at M13). */
export type Profile = {
  matches: number;
  kills: number;
  wins: number;
  look: CosmeticLook;
};

export const EMPTY_PROFILE: Profile = { matches: 0, kills: 0, wins: 0, look: DEFAULT_LOOK };

export function unlockMet(rule: UnlockRule, profile: Profile): boolean {
  switch (rule.type) {
    case 'default':
      return true;
    case 'matches':
      return profile.matches >= rule.n;
    case 'kills':
      return profile.kills >= rule.n;
    case 'wins':
      return profile.wins >= rule.n;
  }
}

export type CosmeticKind =
  | 'livery'
  | 'wheels'
  | 'roof'
  | 'pattern'
  | 'accent'
  | 'glow'
  | 'decal'
  | 'primary'
  | 'secondary'
  | 'gunner'
  | 'outfit';

/** The garage's gun choices, described. Sidegrades: all open from the start. */
export const GUN_CHOICES: Record<'primary' | 'secondary' | 'gunner', readonly { name: string; blurb: string; unlock: UnlockRule }[]> = {
  // Duos and squads: what you hold leaning out of the window (+ a launcher).
  gunner: [
    { name: 'Assault Rifle', blurb: 'fast, steady, any range', unlock: { type: 'default' } },
    { name: 'Shotgun', blurb: 'six pellets, close range', unlock: { type: 'default' } },
    { name: 'Marksman', blurb: 'slow, hard-hitting, long range', unlock: { type: 'default' } },
  ],
  primary: [
    { name: 'Twin .50', blurb: 'a steady stream, all-rounder', unlock: { type: 'default' } },
    { name: 'Scattergun', blurb: 'brutal up close, nothing past 70 m', unlock: { type: 'default' } },
    { name: 'Lancer', blurb: 'slow, heavy rail shots at range', unlock: { type: 'default' } },
  ],
  secondary: [
    { name: 'RPG', blurb: 'one heavy rocket, big splash', unlock: { type: 'default' } },
    { name: 'Swarm', blurb: 'four rockets at once, easier to land', unlock: { type: 'default' } },
  ],
};

/** Is the entry at `index` unlocked for this profile? Out-of-range is locked. */
export function isUnlocked(kind: CosmeticKind, index: number, profile: Profile): boolean {
  const entry = entryAt(kind, index);
  return entry ? unlockMet(entry.unlock, profile) : false;
}

/** The unlock rule for an entry, or null if the index is out of range. */
export function entryAt(
  kind: CosmeticKind,
  index: number,
): { unlock: UnlockRule } | null {
  return listOf(kind)[index] ?? null;
}

function listOf(kind: CosmeticKind): readonly { name: string; unlock: UnlockRule }[] {
  switch (kind) {
    case 'livery':
      return LIVERIES;
    case 'wheels':
      return WHEELS;
    case 'roof':
      return ROOFS;
    case 'pattern':
      return PATTERNS;
    case 'accent':
      return ACCENTS.map((a) => ({ name: a.name, unlock: { type: 'default' } as UnlockRule }));
    case 'glow':
      return GLOWS;
    case 'decal':
      return DECALS;
    case 'primary':
    case 'secondary':
    case 'gunner':
      return GUN_CHOICES[kind];
    case 'outfit':
      return OUTFITS;
  }
}

/** Human-readable requirement, for the shop panel. */
export function requirementLabel(rule: UnlockRule): string {
  switch (rule.type) {
    case 'default':
      return 'unlocked';
    case 'matches':
      return `play ${rule.n} match${rule.n === 1 ? '' : 'es'}`;
    case 'kills':
      return `score ${rule.n} kill${rule.n === 1 ? '' : 's'}`;
    case 'wins':
      return `win ${rule.n} match${rule.n === 1 ? '' : 'es'}`;
  }
}

/** Current progress against a rule, for `3 / 5 matches`. Null when default. */
export function progressToward(rule: UnlockRule, profile: Profile): { at: number; of: number } | null {
  switch (rule.type) {
    case 'default':
      return null;
    case 'matches':
      return { at: profile.matches, of: rule.n };
    case 'kills':
      return { at: profile.kills, of: rule.n };
    case 'wins':
      return { at: profile.wins, of: rule.n };
  }
}

/**
 * Apply one match's outcome to a profile. Cosmetic progression only: this never
 * touches a game rule, and the client is allowed to know its own result.
 */
export function recordMatch(
  profile: Profile,
  result: { won: boolean; kills: number },
): Profile {
  return {
    ...profile,
    matches: profile.matches + 1,
    kills: profile.kills + Math.max(0, Math.floor(result.kills)),
    wins: profile.wins + (result.won ? 1 : 0),
  };
}

/** Every cosmetic with its lock state, for the shop UI. */
export type ShopEntry = {
  kind: CosmeticKind;
  index: number;
  name: string;
  unlocked: boolean;
  requirement: string;
  progress: { at: number; of: number } | null;
};

export function shopCatalog(profile: Profile): ShopEntry[] {
  const out: ShopEntry[] = [];
  const add = (kind: CosmeticKind, list: readonly { name: string; unlock: UnlockRule }[]) => {
    list.forEach((entry, index) => {
      out.push({
        kind,
        index,
        name: entry.name,
        unlocked: unlockMet(entry.unlock, profile),
        requirement: requirementLabel(entry.unlock),
        progress: progressToward(entry.unlock, profile),
      });
    });
  };
  for (const kind of ['livery', 'wheels', 'roof', 'pattern', 'accent', 'glow', 'decal', 'primary', 'secondary', 'gunner', 'outfit'] as const) {
    add(kind, listOf(kind));
  }
  return out;
}
