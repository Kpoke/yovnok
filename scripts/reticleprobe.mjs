/**
 * Diagnostic: what is under the crosshair?
 *
 * The gunner's camera is anchored to the car and looks at it, so the centre of
 * the screen — where the crosshair is drawn — may be sitting on the player's own
 * vehicle rather than on the world. That would make "reticle aiming" a claim
 * rather than a fact, so this measures it instead of assuming.
 *
 *   node scripts/reticleprobe.mjs
 */

import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5173/?crew=0&seat=seat.frontRight';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 6000));

const probe = await page.evaluate(() => {
  const c = window.__convoy;
  if (!c || !c.THREE) return { error: 'no __convoy.THREE handle' };

  const cam = c.camera;
  const dir = new c.THREE.Vector3();
  cam.getWorldDirection(dir);

  const raycaster = new c.THREE.Raycaster(cam.position.clone(), dir.clone());
  raycaster.far = 400;
  const hits = raycaster.intersectObjects(c.scene.children, true);

  // Our own car is the object containing the camera's anchor; label it.
  const own = c.net?.crewId;
  const summarise = (h) => {
    const names = [];
    let o = h.object;
    while (o && names.length < 3) {
      if (o.name) names.unshift(o.name);
      o = o.parent;
    }
    return `${names.join('/') || h.object.type}@${h.distance.toFixed(2)}m`;
  };

  const carPos = c.net?.local?.pos;
  const offset = carPos
    ? {
        lateral: Number((cam.position.x - carPos.x).toFixed(2)),
        vertical: Number((cam.position.y - carPos.y).toFixed(2)),
        along: Number((cam.position.z - carPos.z).toFixed(2)),
      }
    : null;

  return {
    ownCrew: own,
    seat: c.net?.seat,
    carPos: carPos ? [carPos.x, carPos.y, carPos.z].map((n) => Number(n.toFixed(2))) : null,
    cameraOffsetFromCar: offset,
    distanceFromCar: carPos
      ? Number(Math.hypot(cam.position.x - carPos.x, cam.position.y - carPos.y, cam.position.z - carPos.z).toFixed(2))
      : null,
    cameraPos: cam.position.toArray().map((n) => Number(n.toFixed(2))),
    cameraDir: dir.toArray().map((n) => Number(n.toFixed(3))),
    nearest: hits.length ? summarise(hits[0]) : 'nothing',
    firstFive: hits.slice(0, 5).map(summarise),
  };
});

console.log(JSON.stringify(probe, null, 2));
await browser.close();
