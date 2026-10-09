/**
 * Cosmetic checks (M12).
 *
 *   npm run cosmeticstest
 *
 * Two things are worth asserting about cosmetics, and neither is "does it look
 * nice":
 *
 *   1. The unlock economy is honest — thresholds hold at their boundary, and a
 *      match only counts as a win when the server said it did.
 *   2. A cosmetic CANNOT affect play. The strongest available proof is
 *      structural: every catalogue entry is checked to contain only appearance
 *      fields. A future "livery" that quietly carried a grip bonus would fail
 *      here rather than in a balance argument a year from now.
 */

import {
  botLook,
  clampLook,
  DEFAULT_LOOK,
  EMPTY_PROFILE,
  entryAt,
  isUnlocked,
  LIVERIES,
  packLook,
  progressToward,
  recordMatch,
  requirementLabel,
  ROOFS,
  shopCatalog,
  unlockMet,
  unpackLook,
  WHEELS,
  type Profile,
  type UnlockRule,
} from '../src/shared/cosmetics';
import { botCallsign, CALLSIGN_MAX, callsignAllowed, randomCallsign, sanitiseCallsign } from '../src/shared/callsign';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  ...EMPTY_PROFILE,
  look: { ...DEFAULT_LOOK },
  ...overrides,
});

// ------------------------------------------------------------ pack / unpack

{
  const looks = [];
  for (let livery = 0; livery < LIVERIES.length; livery++) {
    for (let wheels = 0; wheels < WHEELS.length; wheels++) {
      for (let roof = 0; roof < ROOFS.length; roof++) {
        looks.push({ livery, wheels, roof });
      }
    }
  }

  const packed = looks.map(packLook);
  check('every look packs to a distinct number', new Set(packed).size === looks.length);

  const roundTrip = looks.every((look, i) => {
    const back = unpackLook(packed[i]);
    return back.livery === look.livery && back.wheels === look.wheels && back.roof === look.roof;
  });
  check('and unpacks back to itself', roundTrip);

  check('the default look survives a round trip', packLook(DEFAULT_LOOK) === packLook(unpackLook(packLook(DEFAULT_LOOK))));

  const clamped = unpackLook(0xffff_ffff);
  check(
    'a hostile packed value clamps into range',
    clamped.livery < LIVERIES.length && clamped.wheels < WHEELS.length && clamped.roof < ROOFS.length,
  );
  check('and a negative index clamps to zero', clampLook({ livery: -5, wheels: -1, roof: -99 }).livery === 0);
  check('and NaN clamps to zero', clampLook({ livery: NaN, wheels: NaN, roof: NaN }).roof === 0);
}

// ------------------------------------------------------------------- unlocks

{
  const rules: UnlockRule[] = [
    { type: 'default' },
    { type: 'matches', n: 3 },
    { type: 'kills', n: 10 },
    { type: 'wins', n: 2 },
  ];

  check('a default rule is always unlocked', unlockMet(rules[0], EMPTY_PROFILE));
  check('a matches rule is locked below the threshold', !unlockMet(rules[1], profile({ matches: 2 })));
  check('and unlocked AT the threshold', unlockMet(rules[1], profile({ matches: 3 })));
  check('a kills rule counts kills', unlockMet(rules[2], profile({ kills: 10 })));
  check('a wins rule counts wins', unlockMet(rules[3], profile({ wins: 2 })));

  check(
    'every default entry is unlocked for a fresh profile',
    LIVERIES.every((l, i) => l.unlock.type !== 'default' || isUnlocked('livery', i, EMPTY_PROFILE)),
  );
  check('an out-of-range index is locked', !isUnlocked('livery', 999, EMPTY_PROFILE));
  check('entryAt past the end is null', entryAt('wheels', 99) === null);

  check('requirement labels read as sentences', requirementLabel({ type: 'kills', n: 1 }) === 'score 1 kill');
  const progress = progressToward({ type: 'matches', n: 5 }, profile({ matches: 2 }));
  check('progress reports what is done and what is needed', progress?.at === 2 && progress?.of === 5);
  check('a default rule has no progress bar', progressToward({ type: 'default' }, EMPTY_PROFILE) === null);
}

// -------------------------------------------------------------- progression

{
  const start = profile({ matches: 4, kills: 7, wins: 1 });
  const lost = recordMatch(start, { won: false, kills: 2 });
  check('a match always counts', lost.matches === 5);
  check('kills accumulate', lost.kills === 9);
  check('a loss does not add a win', lost.wins === 1);

  const won = recordMatch(lost, { won: true, kills: 3 });
  check('a win adds a win', won.wins === 2);
  check('and the match and kills still accumulate', won.matches === 6 && won.kills === 12);

  const negative = recordMatch(start, { won: false, kills: -4 });
  check('a negative kill count cannot reduce the total', negative.kills === start.kills);
}

// ------------------------------------------------------------ shop catalog

{
  const catalog = shopCatalog(profile({ matches: 99, kills: 99, wins: 99 }));
  const total = LIVERIES.length + WHEELS.length + ROOFS.length;
  check('the catalog lists every cosmetic', catalog.length === total, `${catalog.length} entries`);
  check('with everything earned, everything is unlocked', catalog.every((e) => e.unlocked));

  const fresh = shopCatalog(EMPTY_PROFILE);
  const defaults = fresh.filter((e) => e.requirement === 'unlocked').length;
  const expectedDefaults =
    LIVERIES.filter((l) => l.unlock.type === 'default').length +
    WHEELS.filter((w) => w.unlock.type === 'default').length +
    ROOFS.filter((r) => r.unlock.type === 'default').length;
  check('a fresh profile has exactly the default set', defaults === expectedDefaults, `${defaults} free`);
}

// ------------------------------------------------------------------ bot look

{
  const looks = new Set<string>();
  let inRange = true;
  for (let id = 0; id < 30; id++) {
    const look = botLook(id);
    if (look.livery >= LIVERIES.length || look.wheels >= WHEELS.length || look.roof >= ROOFS.length) {
      inRange = false;
    }
    looks.add(`${look.livery}/${look.wheels}/${look.roof}`);
  }
  check('a bot look is always in range', inRange);
  check('and a 30-car field is varied', looks.size >= 8, `${looks.size} distinct looks`);
  check('and is deterministic', packLook(botLook(7)) === packLook(botLook(7)));
}

// ------------------------------------------------ cosmetics cannot affect play

{
  const LIVERY_KEYS = new Set(['id', 'name', 'body', 'finish', 'unlock']);
  const WHEEL_KEYS = new Set(['id', 'name', 'spokes', 'hub', 'unlock']);
  const ROOF_KEYS = new Set(['id', 'name', 'kind', 'unlock']);
  const only = (obj: object, allowed: Set<string>): boolean =>
    Object.keys(obj).every((k) => allowed.has(k));

  check('liveries carry appearance only', LIVERIES.every((l) => only(l, LIVERY_KEYS)));
  check('wheel styles carry appearance only', WHEELS.every((w) => only(w, WHEEL_KEYS)));
  check('roof kits carry appearance only', ROOFS.every((r) => only(r, ROOF_KEYS)));
  check(
    'no unlock rule names a gameplay stat',
    [...LIVERIES, ...WHEELS, ...ROOFS].every((e) => !('speed' in e) && !('damage' in e)),
  );
}

// ---- callsigns (shared by client preview and server) ----
{
  console.log('\n=== callsigns ===');
  check('a callsign is upper-cased and trimmed', sanitiseCallsign('  rust dog ') === 'RUST DOG');
  check('markup and symbols are stripped', sanitiseCallsign('<b>x</b>!@#') === 'BXB', sanitiseCallsign('<b>x</b>!@#'));
  check('runs of spaces collapse', sanitiseCallsign('a    b') === 'A B');
  check('it is capped in length', sanitiseCallsign('x'.repeat(40)).length === CALLSIGN_MAX);
  check('a non-string is no callsign', sanitiseCallsign(42) === '' && sanitiseCallsign(undefined) === '');
  const r = randomCallsign();
  check('a random callsign is already clean', sanitiseCallsign(r) === r && r.length > 0, r);
  check('a bot keeps its callsign', botCallsign(7) === botCallsign(7), botCallsign(7));
  check('bots get varied callsigns', new Set([1, 2, 3, 4, 5, 6, 7, 8].map(botCallsign)).size >= 6);
  check('a slur is blocked, even spaced or disguised', !callsignAllowed('N1GG3R') && !callsignAllowed('F U C K'));
  check('an ambiguous word is blocked on its own', !callsignAllowed('ASS') && !callsignAllowed('BIG ASS'));
  check('but innocent names that contain it pass', ['BASS', 'SCUNTHORPE', 'GRAPEVINE', 'CLASSIC', 'COCKPIT-9', 'ESSEX', 'TORPEDO', 'SPICE', 'RACCOON', 'SHIITAKE'].every(callsignAllowed));
  check('generated callsigns always pass', Array.from({ length: 200 }, () => randomCallsign()).every(callsignAllowed));
  check('every bot name passes', Array.from({ length: 200 }, (_, i) => botCallsign(i)).every(callsignAllowed));
}

console.log(
  failures === 0 ? '\n✓ all cosmetics checks passed\n' : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
