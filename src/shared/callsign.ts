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

/**
 * A basic name filter for a public game. Deliberately small and conservative:
 * it stops the obvious, it is not a moderation system.
 *
 * Look-alike characters are folded first (0→O, 1→I, 3→E, 4→A, 5→S, 7→T, 8→B,
 * @→A, $→S), then:
 *   - SEVERE roots (slurs, unambiguous profanity) are blocked ANYWHERE, even
 *     with the spaces and hyphens taken out ("N I G…", "F-U-C-K");
 *   - AMBIGUOUS words are blocked only as a WHOLE word, so innocent names that
 *     contain them ("BASS", "SCUNTHORPE", "GRAPEVINE") still pass.
 */
const SEVERE = [
  'NIGGER', 'NIGGA', 'FAGGOT', 'RETARD', 'KIKE', 'CHINK', 'TRANNY', 'WETBACK',
  'FUCK', 'SHIT', 'BITCH', 'WHORE', 'SLUT', 'PAEDO', 'NAZI', 'HITLER', 'KKK', 'RAPIST',
];
// Whole words only: each of these hides inside ordinary words — TORPEDO,
// SPICE, RACCOON, BASS, SCUNTHORPE, GRAPEVINE, COCKPIT, ESSEX.
const AMBIGUOUS = [
  'CUNT', 'ASS', 'ARSE', 'DICK', 'COCK', 'PUSSY', 'RAPE', 'FAG', 'TWAT', 'WANK', 'PORN', 'SEX', 'CUM', 'TITS',
  'PEDO', 'SPIC', 'COON',
];

const FOLD: Record<string, string> = { '0': 'O', '1': 'I', '3': 'E', '4': 'A', '5': 'S', '7': 'T', '8': 'B', '@': 'A', $: 'S' };

/** Is this (already sanitised or raw) callsign acceptable? */
export function callsignAllowed(raw: string): boolean {
  const folded = raw.toUpperCase().replace(/[0134578@$]/g, (c) => FOLD[c] ?? c);
  const squashed = folded.replace(/[^A-Z]/g, '');
  if (SEVERE.some((root) => squashed.includes(root))) return false;
  const words = folded.split(/[^A-Z]+/).filter(Boolean);
  return !words.some((word) => AMBIGUOUS.includes(word));
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
