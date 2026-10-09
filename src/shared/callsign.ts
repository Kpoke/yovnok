/**
 * Callsigns: the name a car goes by in the kill feed and the results.
 *
 * No accounts yet, so a callsign is chosen (or generated) in the browser and
 * sent with `hello`. The server cleans it with the SAME function the client
 * uses to preview it, so what you type is what everyone sees. Bots get one too,
 * generated from their id, so the feed reads like a broadcast rather than
 * "car 3 eliminated car 7".
 */

export const CALLSIGN_MAX = 16;

const FIRST = [
  'RUST', 'IRON', 'SCRAP', 'DUST', 'CHROME', 'BLACK', 'RED', 'GRIT', 'HAVOC', 'STEEL',
  'ASH', 'BOLT', 'FLINT', 'GHOST', 'NITRO', 'RAZOR', 'SMOKE', 'TORCH', 'VIPER', 'WRECK',
] as const;
const SECOND = [
  'DOG', 'HOUND', 'JACK', 'WOLF', 'RAT', 'HAWK', 'BULL', 'FANG', 'SKULL', 'MULE',
  'CROW', 'HORNET', 'BADGER', 'COBRA', 'JACKAL', 'LYNX', 'RHINO', 'SHARK', 'TICK', 'VULTURE',
] as const;

/**
 * Clean a callsign: upper case, letters/digits/space/hyphen only, collapsed
 * spaces, at most `CALLSIGN_MAX` characters. Empty means "none given".
 */
export function sanitiseCallsign(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9 -]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CALLSIGN_MAX)
    .trim();
}

/** A random callsign, e.g. "RUSTDOG-41". `random` is injectable for tests. */
export function randomCallsign(random: () => number = Math.random): string {
  const a = FIRST[Math.floor(random() * FIRST.length)];
  const b = SECOND[Math.floor(random() * SECOND.length)];
  return `${a}${b}-${10 + Math.floor(random() * 90)}`;
}

/** A bot's callsign, stable for its id. */
export function botCallsign(id: number): string {
  let seed = (id * 2654435761) >>> 0;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return randomCallsign(next);
}
