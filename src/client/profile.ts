/**
 * The local player profile (M12).
 *
 * Accounts are M13, so progression lives in `localStorage`: which cosmetics are
 * earned, and which one is worn. This is deliberately client-authoritative —
 * cosmetics do not affect play, so there is nothing worth cheating for, and
 * pretending otherwise would mean building an account system one milestone
 * early.
 *
 * Every read is defensive: private-mode browsers throw on `localStorage`, and a
 * stale or hand-edited value must degrade to the default rather than break the
 * game.
 */

import {
  clampLook,
  DEFAULT_LOOK,
  EMPTY_PROFILE,
  recordMatch,
  type CosmeticLook,
  type Profile,
} from '../shared/cosmetics';

const STORAGE_KEY = 'convoy.profile.v1';

function storage(): Storage | null {
  try {
    const s = window.localStorage;
    // Some browsers expose the object but throw on use.
    s.getItem(STORAGE_KEY);
    return s;
  } catch {
    return null;
  }
}

/** Read the saved profile, repairing anything missing or malformed. */
export function loadProfile(): Profile {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return { ...EMPTY_PROFILE, look: { ...DEFAULT_LOOK } };
  try {
    const parsed = JSON.parse(raw) as Partial<Profile>;
    return {
      matches: count(parsed.matches),
      kills: count(parsed.kills),
      wins: count(parsed.wins),
      look: clampLook({
        livery: num(parsed.look?.livery, DEFAULT_LOOK.livery),
        wheels: num(parsed.look?.wheels, DEFAULT_LOOK.wheels),
        roof: num(parsed.look?.roof, DEFAULT_LOOK.roof),
      }),
    };
  } catch {
    return { ...EMPTY_PROFILE, look: { ...DEFAULT_LOOK } };
  }
}

export function saveProfile(profile: Profile): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // A full or unavailable store is not worth interrupting play for.
  }
}

/** Set the worn look, clamped, and persist. Returns the updated profile. */
export function setLook(profile: Profile, look: CosmeticLook): Profile {
  const next: Profile = { ...profile, look: clampLook(look) };
  saveProfile(next);
  return next;
}

/**
 * Apply one finished match to the profile. Called once per results screen, by
 * the client, from the result the server already reported.
 */
export function applyMatch(profile: Profile, result: { won: boolean; kills: number }): Profile {
  const next = recordMatch(profile, result);
  saveProfile(next);
  return next;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
}
