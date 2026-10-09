/**
 * Shape of `public/credits.json`: the in-game credits screen's data.
 *
 * Generated from `assets.json` by `npm run licensecheck -- --write`, so the
 * credits a player sees are the same record the licence gate checks. Sections are
 * grouped by asset kind, author and licence, so each attribution reads once.
 */
export type CreditsSection = {
  /** e.g. "MUSIC", "3D MODELS". */
  heading: string;
  items: { title: string; source: string }[];
  /** Author, as they ask to be credited. */
  attribution: string;
  /** Human licence name, e.g. "CC BY 4.0". */
  license: string;
  /** Link to the licence deed; CC BY requires one. */
  licenseUrl: string;
};
