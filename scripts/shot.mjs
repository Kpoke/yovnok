/**
 * Headless capture — renders the running game and saves screenshots.
 *
 * This exists so the renderer can be verified without a human and without a
 * desktop browser attached to the session. It also dumps console output, which
 * is how we catch WebGL/three.js failures that a typecheck can never see.
 *
 * Headless Chrome has no GPU, so WebGL comes from SwiftShader and needs
 * --enable-unsafe-swiftshader on modern Chrome builds. rAF throttling is
 * disabled so the game loop actually runs at speed.
 *
 * Usage:
 *   node scripts/shot.mjs
 *   OUT=drive.png DRIVE_MS=6000 KEYS=w node scripts/shot.mjs
 */

import { chromium } from 'playwright';

const url = process.env.URL ?? 'http://localhost:5174/';
const out = process.env.OUT ?? 'shot.png';
const driveMs = Number(process.env.DRIVE_MS ?? 0);
// Comma-separated. Single characters are treated as letters, so both
// "w,a" and "w,a,Space,Shift" work.
const keyAliases = { space: ' ', shift: 'Shift' };
const parseKeys = (raw) =>
  raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => keyAliases[k.toLowerCase()] ?? k);

const keys = parseKeys(process.env.KEYS ?? 'w');
// Optional second stage: release the first keys and press these instead. Lets a
// capture reproduce a manoeuvre (build speed, THEN handbrake into a turn)
// rather than holding one key set for the whole run.
const keys2 = parseKeys(process.env.KEYS2 ?? '');
/** Hold the trigger for the drive, so firing can be captured. */
const fire = process.env.FIRE === '1';
const driveMs2 = Number(process.env.DRIVE_MS2 ?? 0);
const coastMs = Number(process.env.COAST_MS ?? 0);
const checkTracers = process.env.CHECK_TRACERS === '1';
let tracerSegments = null;
const settleMs = Number(process.env.SETTLE_MS ?? 2200);
const width = Number(process.env.W ?? 1280);
const height = Number(process.env.H ?? 720);

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

const page = await browser.newPage({ viewport: { width, height } });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(url, { waitUntil: 'load', timeout: 30000 });
// Give the scene a moment to build and the sim to settle the car on the ground.
await page.waitForTimeout(settleMs);

// Optionally orbit the camera, which is how the vehicle gets inspected from
// angles the chase cam never shows.
const lookYaw = Number(process.env.LOOK_YAW ?? 0);
const lookPitch = Number(process.env.LOOK_PITCH ?? 0);
if (lookYaw !== 0 || lookPitch !== 0) {
  await page.evaluate(
    ([yaw, pitch]) => {
      const inputs = window.__convoy?.inputs;
      if (inputs) {
        inputs.lookYaw = yaw;
        inputs.lookPitch = pitch;
      }
    },
    [lookYaw, lookPitch],
  );
  await page.waitForTimeout(400);
}

// Confirm a WebGL context exists at all, and find out what is rendering it.
const gl = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const ctx =
    canvas?.getContext('webgl2') ??
    canvas?.getContext('webgl') ??
    document.createElement('canvas').getContext('webgl2');
  if (!ctx) return { ok: false };
  const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
  return {
    ok: true,
    renderer: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : String(ctx.getParameter(ctx.RENDERER)),
    drawingBufferWidth: ctx.drawingBufferWidth,
    drawingBufferHeight: ctx.drawingBufferHeight,
  };
});

const readHud = () =>
  page.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent ?? null;
    return {
      speed: t('speed-value'),
      state: t('t-state'),
      fps: t('t-fps'),
      boost: t('boost-pct'),
      netStatus: t('t-status'),
      players: t('t-players'),
      ping: t('t-ping'),
    };
  });

// Drive, if asked. Optionally sample speed along the way, which is how the
// acceleration CURVE gets checked rather than just its end point.
const samples = [];
let hudDriving = null;
if (driveMs > 0) {
  for (const k of keys) await page.keyboard.down(k);
  if (fire) await page.mouse.down();

  // Sample while firing. A line that lives 110 ms against a 111 ms fire interval
  // means any single sample misses about half the time, so the max over a
  // second of firing is the honest measure.
  if (checkTracers) {
    const countLive = () =>
      page.evaluate(() => {
        const t = window.__convoy?.tracers;
        if (!t) return { live: -1, longest: 0 };
        const p = t.object.geometry.getAttribute('position').array;
        let live = 0;
        let longest = 0;
        for (let i = 0; i < p.length; i += 6) {
          const len = Math.hypot(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
          if (len > 0.01) live++;
          longest = Math.max(longest, len);
        }
        return { live, longest: Number(longest.toFixed(2)) };
      });
    let best = { live: 0, longest: 0 };
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(60);
      const sample = await countLive();
      if (sample.live > best.live) best = sample;
      best.longest = Math.max(best.longest, sample.longest);
    }
    tracerSegments = best;
  }

  const sampleEvery = Number(process.env.SAMPLE_MS ?? 0);
  if (sampleEvery > 0) {
    let elapsed = 0;
    while (elapsed < driveMs) {
      const slice = Math.min(sampleEvery, driveMs - elapsed);
      await page.waitForTimeout(slice);
      elapsed += slice;
      const h = await readHud();
      samples.push({ t: (elapsed / 1000).toFixed(2), speed: h.speed, boost: h.boost });
    }
  } else {
    await page.waitForTimeout(driveMs);
  }
  hudDriving = await readHud();
  for (const k of keys) await page.keyboard.up(k);
  if (fire) await page.mouse.up();
  await page.waitForTimeout(120);
}

// Second stage. Keys are deliberately left HELD so the capture catches the
// manoeuvre in progress.
let hudManoeuvre = null;
if (driveMs2 > 0 && keys2.length > 0) {
  for (const k of keys2) await page.keyboard.down(k);
  await page.waitForTimeout(driveMs2);
  hudManoeuvre = await readHud();
}

// Optionally watch it coast down with all input released. This is how the
// "lift off and it comes to a stop" behaviour gets verified end-to-end in a
// real browser rather than only in the headless sim.
let hudCoasting = null;
if (coastMs > 0) {
  await page.waitForTimeout(coastMs);
  hudCoasting = await readHud();
}

const hud = await readHud();

await page.screenshot({ path: out });

// Is the canvas actually drawing, or is it a flat clear colour?
const pixels = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!gl) return null;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const seen = new Set();
  for (let i = 0; i < buf.length; i += 4 * 997) {
    seen.add(`${buf[i] >> 4},${buf[i + 1] >> 4},${buf[i + 2] >> 4}`);
  }
  return { distinctColourBuckets: seen.size };
});

console.log(
  JSON.stringify(
    {
      url,
      out,
      gl,
      samples,
      hudDriving,
      hudManoeuvre,
      hudCoasting,
      hud,
      pixels,
      tracerSegments,
      console: logs.slice(0, 40),
    },
    null,
    2,
  ),
);

await browser.close();
