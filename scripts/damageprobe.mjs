/**
 * Diagnostic: does damage actually LOOK like anything?
 *
 * The damage effects (client/damageFx.ts) and wheel deformation are driven from component health
 * and hull, and neither is visible in a unit test — "a puff mesh exists" is not
 * the same claim as "a damaged car reads as damaged from across the arena".
 * This drives the rig directly with damaged values, which is the only way to
 * see the effect without staging a live firefight.
 *
 *   node scripts/damageprobe.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.env.URL ?? 'http://localhost:5173/?crew=0&seat=seat.driver';
const out = process.env.OUT ?? 'shots/m6-damage.png';
const hull = Number(process.env.HULL ?? 140); // 1200 max

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 6000));

const report = await page.evaluate(
  async ({ hull, frames }) => {
    const c = window.__convoy;
    const rig = c.localCar;
    if (!rig) return { error: 'no localCar handle' };

    const state = c.net.renderState;
    const neutrals = { throttle: 0, steer: 0, handbrake: false, boost: false };

    // Damage the car and hold it there. The game loop keeps writing real values
    // back, so this drives the rig directly — the point is to see the effect,
    // not to prove the plumbing (combattest covers that).
    state.components.engine = 0;
    state.components['wheel.fl'] = 0;
    state.components['wheel.rl'] = 0;
    state.components['wheel.fr'] = 120;

    for (let i = 0; i < frames; i++) {
      rig.update(state, neutrals, 1 / 60, { hull, maxHull: 1200 });
      c.damageFx.emit(-2, rig.root, rig.damageAnchors, { x: 0, y: 0, z: 0 }, rig.damage, 1 / 60);
      await new Promise((r) => requestAnimationFrame(r));
    }

    const wheelPivots = rig.root.children.filter((o) => o.type === 'Group');
    return {
      damage: rig.damage,
      wheelChildren: wheelPivots.length,
      engineHealth: state.components.engine,
    };
  },
  { hull, frames: 120 },
);

mkdirSync('shots', { recursive: true });
await page.screenshot({ path: out });
console.log(JSON.stringify(report, null, 2));
console.log(`screenshot: ${out}`);
await browser.close();
