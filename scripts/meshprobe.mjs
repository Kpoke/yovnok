/**
 * Diagnostic: what does one car cost the renderer, and what does a full match
 * cost?
 *
 * Draw calls per vehicle are the client-side ceiling. They are also exact,
 * unlike frame time, which under headless SwiftShader is software rasterised and
 * tells you nothing about a real GPU. Triangles and draw calls are the same on
 * any hardware, so they are what this reports.
 *
 *   node scripts/meshprobe.mjs
 */

import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5173/?crew=0&seat=seat.driver';
const counts = (process.env.COUNTS ?? '1,8,30').split(',').map(Number);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 6000));

const report = await page.evaluate(async (counts) => {
  const c = window.__convoy;
  const rig = c.localCar;
  if (!rig) return { error: 'no localCar handle' };

  // What a single car is made of.
  let meshes = 0;
  const geometries = new Set();
  const materials = new Set();
  rig.root.traverse((o) => {
    if (!o.visible) return;
    if (o.isMesh) {
      meshes++;
      geometries.add(o.geometry.uuid);
      const m = o.material;
      materials.add(Array.isArray(m) ? m.map((x) => x.uuid).join() : m.uuid);
    }
  });

  const rows = [];
  for (const count of counts) {
    // Park `count` copies of the car in a ring around the player.
    const clones = [];
    for (let i = 0; i < count; i++) {
      const clone = rig.root.clone(true);
      const angle = (i / count) * Math.PI * 2;
      clone.position.set(Math.sin(angle) * 45, rig.spec.rideHeight, Math.cos(angle) * 45);
      clone.rotation.y = angle;
      c.scene.add(clone);
      clones.push(clone);
    }

    await new Promise((r) => requestAnimationFrame(r));
    // One render populates `info`; the second is the one we read.
    c.renderer.render(c.scene, c.camera);
    c.renderer.render(c.scene, c.camera);
    const info = c.renderer.info.render;

    const withShadows = { calls: info.calls, triangles: info.triangles };

    // The shadow pass re-draws every caster, so it is a MULTIPLIER on geometry
    // and draw calls rather than a fixed cost. Measuring it is the only way to
    // know what a heavy asset actually costs on screen.
    c.renderer.shadowMap.enabled = false;
    c.renderer.render(c.scene, c.camera);
    c.renderer.render(c.scene, c.camera);
    const noShadows = {
      calls: c.renderer.info.render.calls,
      triangles: c.renderer.info.render.triangles,
    };
    c.renderer.shadowMap.enabled = true;
    c.scene.traverse((o) => {
      if (o.material) o.material.needsUpdate = true;
    });

    rows.push({
      cars: count,
      drawCalls: withShadows.calls,
      triangles: withShadows.triangles,
      callsPerCar: Number((withShadows.calls / count).toFixed(1)),
      trianglesPerCar: Math.round(withShadows.triangles / count),
      shadowPassCalls: withShadows.calls - noShadows.calls,
      shadowPassTriangles: withShadows.triangles - noShadows.triangles,
    });

    for (const clone of clones) c.scene.remove(clone);
  }

  return {
    meshesPerCar: meshes,
    uniqueGeometriesPerCar: geometries.size,
    uniqueMaterialsPerCar: materials.size,
    rows,
  };
}, counts);

console.log(JSON.stringify(report, null, 2));
console.log(
  '\nNote: draw calls and triangles are exact and hardware-independent.\n' +
    'Frame time here would not be — headless Chromium rasterises in software.',
);
await browser.close();
