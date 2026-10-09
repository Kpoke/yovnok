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

export type RoofKind = 'none' | 'rack' | 'wing' | 'scoop' | 'lights';

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

export const WHEELS: readonly WheelStyle[] = [
  { id: 'steel', name: 'Steel', spokes: 0, hub: 0xa7b0bb, unlock: { type: 'default' } },
  { id: 'sport', name: 'Sport Five', spokes: 5, hub: 0xcfd6df, unlock: { type: 'default' } },
  { id: 'mesh', name: 'Mesh Nine', spokes: 9, hub: 0x9aa3ad, unlock: { type: 'matches', n: 8 } },
  { id: 'gold', name: 'Gold Teeth', spokes: 5, hub: 0xe8c35a, unlock: { type: 'kills', n: 25 } },
];

export const ROOFS: readonly RoofKit[] = [
  { id: 'clean', name: 'Clean', kind: 'none', unlock: { type: 'default' } },
  { id: 'rack', name: 'Roof Rack', kind: 'rack', unlock: { type: 'default' } },
  { id: 'scoop', name: 'Hood Scoop', kind: 'scoop', unlock: { type: 'matches', n: 5 } },
  { id: 'wing', name: 'Rear Wing', kind: 'wing', unlock: { type: 'kills', n: 15 } },
  { id: 'lights', name: 'Light Bar', kind: 'lights', unlock: { type: 'wins', n: 3 } },
];

export type CosmeticLook = {
  /** Index into `LIVERIES`. */
  livery: number;
  /** Index into `WHEELS`. */
  wheels: number;
  /** Index into `ROOFS`. */
  roof: number;
};

export const DEFAULT_LOOK: CosmeticLook = { livery: 0, wheels: 0, roof: 0 };

/** Clamp every index into range, so a stale profile cannot crash a render. */
export function clampLook(look: CosmeticLook): CosmeticLook {
  return {
    livery: clampIndex(look.livery, LIVERIES.length),
    wheels: clampIndex(look.wheels, WHEELS.length),
    roof: clampIndex(look.roof, ROOFS.length),
  };
}

function clampIndex(v: number, length: number): number {
  if (!Number.isFinite(v)) return 0;
  const i = Math.floor(v);
  return i < 0 ? 0 : i >= length ? length - 1 : i;
}

/**
 * Pack a look into one integer for the wire: livery in the low byte, wheels in
 * the next nibble, roof in the one after. Three numbers per vehicle per tick
 * would be three fields in the hottest message in the game; one is enough.
 */
export function packLook(look: CosmeticLook): number {
  const l = clampLook(look);
  return (l.livery & 0xff) | ((l.wheels & 0xf) << 8) | ((l.roof & 0xf) << 12);
}

export function unpackLook(packed: number): CosmeticLook {
  const n = Number.isFinite(packed) ? Math.floor(packed) : 0;
  return clampLook({ livery: n & 0xff, wheels: (n >> 8) & 0xf, roof: (n >> 12) & 0xf });
}

/**
 * A deterministic look for a bot, so a 30-car field is varied rather than all
 * one colour. Bots ignore unlocks: they are the field, not customers.
 */
export function botLook(id: number): CosmeticLook {
  return {
    livery: Math.abs(id) % LIVERIES.length,
    wheels: Math.abs(id * 7 + 1) % WHEELS.length,
    roof: Math.abs(id * 5 + 2) % ROOFS.length,
  };
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

export type CosmeticKind = 'livery' | 'wheels' | 'roof';

/** Is the entry at `index` unlocked for this profile? Out-of-range is locked. */
export function isUnlocked(kind: CosmeticKind, index: number, profile: Profile): boolean {
  const entry = entryAt(kind, index);
  return entry ? unlockMet(entry.unlock, profile) : false;
}

/** The unlock rule for an entry, or null if the index is out of range. */
export function entryAt(
  kind: CosmeticKind,
  index: number,
): Livery | WheelStyle | RoofKit | null {
  const list = kind === 'livery' ? LIVERIES : kind === 'wheels' ? WHEELS : ROOFS;
  return list[index] ?? null;
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
  add('livery', LIVERIES);
  add('wheels', WHEELS);
  add('roof', ROOFS);
  return out;
}
