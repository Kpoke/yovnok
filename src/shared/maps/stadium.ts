/**
 * THE STADIUM — the floodlit night arena: concrete floor, container cover, a
 * drivable mesa, a ring road with checkpoints, stands all round.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, zoneGround } from './kit';
import type { ArenaMap } from './types';

/**
 * One quadrant of the map. Everything here is replicated by rotation, so this
 * is the only place layout is authored.
 */
const WEDGE: Solid[] = [
  // ---- inner ring: the objective's doorstep -----------------------------
  // Ramp up onto the central platform, from this quadrant's side.
  ramp({ x: -6, y: 0, z: 11 }, { x: 6, y: 3.4, z: 23 }, 'z', 3.4, 0, PALETTE.ramp),
  // Cover close to the pad, so the fight over the centre has something to use.
  box({ x: 30, y: 0, z: 30 }, { x: 44, y: 5, z: 44 }, PALETTE.block),

  // ---- middle ring: room to manoeuvre ----------------------------------
  // Launch ramp, off the cardinal axes so it does not fight the centre ramps.
  ramp({ x: 62, y: 0, z: 16 }, { x: 78, y: 3.6, z: 32 }, 'z', 3.6, 0, PALETTE.ramp),
  // A second, opposite ramp so both approaches to the middle can be launched.
  ramp({ x: 16, y: 0, z: 96 }, { x: 32, y: 3.6, z: 112 }, 'x', 3.6, 0, PALETTE.ramp),
  // Flanking blocks: cover that gives a second angle on the centre approach,
  // sized to break line of sight for a CAR rather than a person.
  box({ x: 54, y: 0, z: 56 }, { x: 68, y: 5.5, z: 70 }, PALETTE.block),
  box({ x: 20, y: 0, z: 74 }, { x: 34, y: 3.4, z: 88 }, PALETTE.block),

  // ---- outer ring: the landmarks ---------------------------------------
  // Tall and unmistakable — the thing you navigate by.
  box({ x: 120, y: 0, z: 120 }, { x: 138, y: 11, z: 138 }, PALETTE.block),
  // Outer cover on both flanks of the quadrant, so the rim is not a race track.
  box({ x: 114, y: 0, z: 40 }, { x: 130, y: 4.5, z: 56 }, PALETTE.block),
  box({ x: 40, y: 0, z: 114 }, { x: 56, y: 4.5, z: 130 }, PALETTE.block),

  // Hazard patch. Flat and drivable, and DAMAGING while you are on it
  // (DESIGN.md §10.3) — which is why it is called out rather than being just
  // another block. Kept clear of the spawn ring.
  // Moved in from (80..100): at the smaller duel spawn radius the old patch
  // overlapped the 8-point spawn ring, which the "no spawn on a hazard" test
  // caught. A hazard under a spawn is a crew damaged on arrival.
  { ...box({ x: 40, y: 0, z: 90 }, { x: 60, y: 0.06, z: 110 }, PALETTE.hazard), hazard: true },

  // ---- the far zones (M11) ---------------------------------------------
  // Everything above sits within ~200 m of the centre. These carry the map out
  // toward the 360 m spawn ring, and their CHARACTER is the zoning: dunes have
  // launch ramps, the scrapyard is dense cover, the lakebed is open with a
  // second hazard. Authored inside one quadrant, so all four are identical.
  // Corners are kept inside ~320 m so the spawn ring stays clear.

  // Dunes: ramps and low cover, room to run.
  ramp({ x: 150, y: 0, z: 60 }, { x: 166, y: 3.6, z: 76 }, 'z', 3.6, 0, PALETTE.ramp),
  box({ x: 190, y: 0, z: 110 }, { x: 214, y: 4, z: 134 }, PALETTE.block),
  box({ x: 130, y: 0, z: 200 }, { x: 154, y: 4, z: 224 }, PALETTE.block),

  // The stadium edge: one block just inside the barrier. (The old scrapyard,
  // lakebed hazard and their outer blocks lay beyond STADIUM_HALF and went
  // with it — see the barrier in SOLIDS.)
  box({ x: 210, y: 0, z: 190 }, { x: 232, y: 5, z: 212 }, PALETTE.block),

  // ---- authored pass (M12): verticality, landmarks, roads ----------------
  // The map so far is cover at ground level. This adds the two things it was
  // missing: somewhere to be TALL, and a route to follow.

  // The mesa: the map's one piece of real high ground. A flat plateau with a
  // ramp on two sides, so taking the top is a position rather than a dead end.
  // Drivable on purpose — high ground a car can reach is a fight over it. It
  // sits in the open pocket between the inner ramps and the dunes, clear of the
  // 140 m duel spawn ring.
  box({ x: 150, y: 0, z: 20 }, { x: 188, y: 4.2, z: 56 }, PALETTE.plateau),
  ramp({ x: 134, y: 0, z: 26 }, { x: 150, y: 4.2, z: 46 }, 'x', 0, 4.2, PALETTE.ramp),
  ramp({ x: 188, y: 0, z: 26 }, { x: 204, y: 4.2, z: 46 }, 'x', 4.2, 0, PALETTE.ramp),


  // Roads. Authored as ground strips ALONG THE AXES, so replicating the
  // quadrant builds a square ring road and four cardinal spokes. They are
  // drivable and non-blocking — a route and a sense of place, not obstacles —
  // and sit 11 mm above the ring so the ground query still prefers them.
  { ...box({ x: 30, y: -4, z: -6 }, { x: 120, y: 0.05, z: 6 }, PALETTE.road), ground: true },

  // A checkpoint on each spoke road (arena dressing): two staggered lines of
  // concrete road barriers make a chicane across the 12 m road — weave through
  // it, or go round on the dirt — and a nest of barrels, tyres and crates sits
  // beside it. Low (0.85 m) cover: it hides a car's wheels, not its hull.
  { ...box({ x: 88, y: 0, z: -6 }, { x: 88.7, y: 0.85, z: -1.4 }, PALETTE.block), prop: 'barriers' },
  { ...box({ x: 97, y: 0, z: 1.4 }, { x: 97.7, y: 0.85, z: 6 }, PALETTE.block), prop: 'barriers' },
  { ...box({ x: 91, y: 0, z: 8.5 }, { x: 95, y: 1.2, z: 11.5 }, PALETTE.block), prop: 'nest' },
  { ...box({ x: 120, y: -4, z: -6 }, { x: STADIUM_HALF, y: 0.05, z: 6 }, PALETTE.road), ground: true },
];

export const STADIUM: ArenaMap = {
  id: 'stadium',
  name: 'The Stadium',
  blurb: 'Floodlit night · containers and a mesa',
  lighting: 'floodlitNight',
  grip: 1,
  solids: [
    ...zoneGround(),
    ...boundary(),
    // The contested centre: centred and square, symmetric without replication.
    box({ x: -11, y: 0, z: -11 }, { x: 11, y: 3.4, z: 11 }, PALETTE.pad),
    ...repeat4(WEDGE),
  ],
  // One crate per quadrant ~232 m out, between the dunes and the rim, plus one
  // contested at the centre.
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
