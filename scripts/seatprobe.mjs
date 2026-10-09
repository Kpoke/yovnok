/**
 * Diagnostic: are the occupant meshes where they should be, and shown only when
 * someone is sitting there?
 *
 * An earlier pass drew occupants at the CAMERA offset, which put two boxes
 * floating half a metre off each flank. This checks position and visibility
 * rather than trusting a screenshot to catch it.
 *
 *   node scripts/seatprobe.mjs
 */

import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5173/?crew=0&seat=seat.driver';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 6000));

const report = await page.evaluate(() => {
  const c = window.__convoy;
  const rig = c?.localCar;
  if (!rig) return { error: 'no localCar handle' };

  const collect = () => {
    const out = [];
    for (const [seatId, meshes] of rig.occupantMeshes ?? []) {
      for (const m of meshes) {
        out.push({
          seat: seatId,
          visible: m.visible,
          x: Number(m.position.x.toFixed(2)),
          y: Number(m.position.y.toFixed(2)),
          z: Number(m.position.z.toFixed(2)),
        });
      }
    }
    return out;
  };

  const hidden = collect();
  // Pretend a gunner is in the front-right seat.
  rig.setOccupants(new Set(['seat.frontRight']));
  const shown = collect();

  return {
    halfWidth: rig.spec.halfWidth,
    driverSeatHasOccupantMesh: hidden.some((m) => m.seat === 'seat.driver'),
    hiddenCount: hidden.filter((m) => m.visible).length,
    totalMeshes: hidden.length,
    shownSeats: [...new Set(shown.filter((m) => m.visible).map((m) => m.seat))],
    positions: hidden,
  };
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
