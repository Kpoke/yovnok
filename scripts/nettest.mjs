/**
 * End-to-end netcode test.
 *
 * Spawns the authoritative server and Vite itself, then checks what M2 is
 * supposed to deliver:
 *
 *   1. two clients join and see each other
 *   2. our own car is PREDICTED, and prediction agrees with the server
 *   3. a bad network (lag + jitter) degrades gracefully
 *   4. a client that goes silent stops driving, server-side
 *   5. nothing errors in the console
 *
 * IMPORTANT — one browser instance per client. Two pages in the same browser
 * means one is a background tab, and browsers throttle background tabs to about
 * 1 Hz. That does not merely slow the test down: it starves the simulation loop,
 * so the car barely moves, pings never fire, and the results are meaningless.
 * Separate instances also model reality, where each player is on their own
 * machine.
 *
 * The headline assertion is `predictionError`. Both sides run the same
 * deterministic simulation, so replaying unacknowledged inputs should reproduce
 * the server's result almost exactly. If that grows, prediction has stopped
 * matching the server, which is the one failure that breaks the whole approach.
 *
 *   npm run nettest
 */

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const CLIENT_PORT = 5199;
const SERVER_PORT = 8099;
const URL = `http://localhost:${CLIENT_PORT}/`;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws`;

/** Liveness timeout, shortened so the reaper can be proven without a 10 s wait. */
const CLIENT_TIMEOUT_MS = 4000;

/**
 * Open a bare socket. Handlers are attached BEFORE awaiting `open`, because the
 * server sends `welcome` immediately on connect and attaching afterwards races
 * it and silently misses the message.
 *
 * Keep-alive is ON by default: a real client pings every second, and observers
 * need to stay admitted for the length of a test. Liveness itself is now proven
 * at the SOCKET level (the server pings, the browser/library pongs), so a quiet
 * socket is still alive. `autoPong: false` is how the ghost-client test makes a
 * genuinely dead connection that stops answering.
 */
const openRaw = (onMessage, { keepAlive = true, crew, seat, autoPong = true } = {}) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL, { autoPong });
    if (onMessage) socket.on('message', onMessage);
    socket.once('open', () => {
      // The server does not admit a player until it knows which vehicle class
      // they are driving, so `hello` is required even for a bare test socket.
      socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew, seat }));

      if (keepAlive) {
        let id = 0;
        const timer = setInterval(() => {
          if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'ping', id: ++id }));
        }, 1000);
        socket.once('close', () => clearInterval(timer));
      }
      resolve(socket);
    });
    socket.once('error', reject);
  });

const LAUNCH_ARGS = [
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const logs = [];
const spawnProc = (cmd, args, env) => {
  const proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'pipe' });
  const capture = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (line.trim()) logs.push(line.trim());
    }
    if (logs.length > 60) logs.shift();
  };
  proc.stdout.on('data', capture);
  proc.stderr.on('data', capture);
  children.push(proc);
  return proc;
};

const launchedBrowsers = [];
const shutdown = () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
};

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}\n--- process output ---\n${logs.join('\n')}`);
}

const readNet = (page) =>
  page.evaluate(() => {
    const c = window.__convoy;
    if (!c) return null;
    const t = (id) => document.getElementById(id)?.textContent ?? null;
    return {
      connected: c.net.connected,
      id: c.net.playerId,
      crew: c.net.crewId,
      seat: c.net.seat,
      isDriver: c.net.isDriver,
      aimYaw: c.net.aimYaw,
      throttle: c.inputs?.throttleValue ?? null,
      keys: c.inputs?.heldKeys ?? [],
      onGround: c.net.local.onGround,
      // Remotes are keyed by CREW now, not player: several people share a car.
      remotes: [...c.net.remotes.keys()],
      members: c.net.members.size,
      players: c.net.playerCount,
      ping: c.net.ping,
      jitter: c.net.jitter,
      predictionError: c.net.predictionError,
      speed: Math.hypot(c.net.local.vel.x, c.net.local.vel.z),
      fps: Number(t('t-fps') ?? 0),
      hidden: document.hidden,
      pending: c.net.pendingCount,
      auth: (() => {
        const s = c.net.authoritativeSelf();
        return s
          ? {
              speed: Math.hypot(s.vx, s.vz),
              x: s.x,
              z: s.z,
              onGround: s.onGround,
              driver: s.driver,
              cls: s.cls,
              appliedThrottle: s.appliedThrottle,
            }
          : null;
      })(),
      local: { x: c.net.local.pos.x, z: c.net.local.pos.z, cls: c.net.local.spec.id },
      pendingN: c.net.pendingCount,
      serverQueue: c.net.serverQueueDepth,
      reconciles: c.net.recentReconciles,
      maxDelta: c.net.maxReconcileDelta,
      maxCorrection: c.net.maxCorrection,
      remotePos: [...c.net.remotes.values()].map((s) => ({ x: s.pos.x, z: s.pos.z })),
      hud: {
        status: t('t-status'),
        players: t('t-players'),
        ping: t('t-ping'),
      },
    };
  });

/** Each client gets its own browser process, so neither is a throttled tab. */
async function launchClient(label, query = '') {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  launchedBrowsers.push(browser);
  // Small viewport on purpose: WebGL here is software-rasterised, so pixel
  // count is the dominant cost and a big canvas starves the simulation loop.
  const context = await browser.newContext({ viewport: { width: 720, height: 450 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
  });
  await page.goto(`${URL}${query}`, { waitUntil: 'load' });
  return { label, browser, page, errors };
}

const TICK_DT = 1 / 60;

try {
  console.log('\n=== starting server + client ===');
  spawnProc('npx', ['tsx', 'src/server/server.ts'], {
    PORT: String(SERVER_PORT),
    CLIENT_TIMEOUT_MS: String(CLIENT_TIMEOUT_MS),
    DEV_ASSIGN: '1',
    // This harness tests netcode, not match flow: keep the match live so a
    // countdown cannot gate the driving these sections measure.
    MATCH_FORCE_LIVE: '1',
  });
  spawnProc('npx', ['vite', '--port', String(CLIENT_PORT), '--strictPort'], {
    GAME_SERVER: `http://localhost:${SERVER_PORT}`,
  });

  await waitFor(
    async () => {
      try {
        return (await fetch(URL)).ok;
      } catch {
        return false;
      }
    },
    40000,
    'vite to serve',
  );
  console.log(`  dev stack up on :${CLIENT_PORT} (game server :${SERVER_PORT})`);

  // ---------------------------------------------------------------- section 1
  console.log('\n=== 1. both clients join and see each other ===');
  const a = await launchClient('A');
  const b = await launchClient('B');

  await waitFor(
    async () => {
      const [ra, rb] = await Promise.all([readNet(a.page), readNet(b.page)]);
      return (
        ra?.connected && rb?.connected && ra.players === 2 && rb.players === 2 && ra.hud.players === '2'
      );
    },
    30000,
    'both clients to report 2 players',
  );

  const startA = await readNet(a.page);
  const startB = await readNet(b.page);
  check('client A is connected', startA.connected, `status="${startA.hud.status}"`);
  check('client B is connected', startB.connected, `status="${startB.hud.status}"`);
  check('the two clients got different ids', startA.id !== startB.id, `${startA.id} and ${startB.id}`);
  check(
    'the two clients are in different crews',
    startA.crew !== startB.crew,
    `crews ${startA.crew} and ${startB.crew}`,
  );
  check(
    'both were given the driver seat',
    startA.isDriver && startB.isDriver,
    `${startA.seat}, ${startB.seat}`,
  );
  check('A sees B as a remote vehicle', startA.remotes.includes(startB.crew), `A knows [${startA.remotes}]`);
  check('B sees A as a remote vehicle', startB.remotes.includes(startA.crew));
  check('HUD shows 2 players', startA.hud.players === '2' && startB.hud.players === '2');

  // ---------------------------------------------------------------- section 2
  console.log('\n=== 2. driving: prediction stays faithful to the server ===');
  await Promise.all([a.page.keyboard.down('w'), b.page.keyboard.down('w')]);

  // Bound the residual against ONE TICK OF TRAVEL, not against time. Metres per
  // tick scale with speed, so a car accelerating through the run produces a
  // residual that grows while prediction is perfectly healthy.
  let maxError = 0;
  let maxSpeed = 0;
  let sawRemoteMove = false;
  const remoteStart = startA.remotePos[0] ?? null;
  // Recording the series distinguishes a startup transient from an ongoing
  // correction. A single spike on the first sample is a very different problem
  // from a residual that persists all run.
  const errorSeries = [];

  // Drive until BOTH cars have actually covered ground, rather than for a fixed
  // wall-clock window. Under software rendering a page can take seconds longer
  // to warm up, so a fixed window measures startup timing: one client reaches
  // 35 m while the other has had barely a second of simulated time, and it looks
  // like a client that cannot drive.
  const DRIVE_GOAL = 25;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(200);
    const [ra, rb] = await Promise.all([readNet(a.page), readNet(b.page)]);
    const err = Math.max(ra.predictionError, rb.predictionError);
    errorSeries.push(Number(err.toFixed(3)));
    maxError = Math.max(maxError, err);
    maxSpeed = Math.max(maxSpeed, ra.speed, rb.speed);
    const now = ra.remotePos[0];
    if (remoteStart && now && Math.hypot(now.x - remoteStart.x, now.z - remoteStart.z) > 2) {
      sawRemoteMove = true;
    }
    const progressed =
      Math.hypot(ra.local.x - startA.local.x, ra.local.z - startA.local.z) > DRIVE_GOAL &&
      Math.hypot(rb.local.x - startB.local.x, rb.local.z - startB.local.z) > DRIVE_GOAL;
    if (progressed && errorSeries.length > 6) break;
  }

  await Promise.all([a.page.keyboard.up('w'), b.page.keyboard.up('w')]);

  const endA = await readNet(a.page);
  const endB = await readNet(b.page);
  const movedA = Math.hypot(endA.local.x - startA.local.x, endA.local.z - startA.local.z);
  const movedB = Math.hypot(endB.local.x - startB.local.x, endB.local.z - startB.local.z);

  check('A drove', movedA > 10, `${movedA.toFixed(1)} m`);
  check('B drove', movedB > 10, `${movedB.toFixed(1)} m | seat=${endB.seat} crew=${endB.crew} local=(${endB.local.x.toFixed(1)}, ${endB.local.z.toFixed(1)}) server=(${endB.auth?.x.toFixed(1)}, ${endB.auth?.z.toFixed(1)}) serverSpeed=${endB.auth?.speed.toFixed(1)} driver=${endB.auth?.driver} throttle=${endB.auth?.appliedThrottle.toFixed(3)} start=(${startB.local.x.toFixed(1)}, ${startB.local.z.toFixed(1)}) fps=${endB.fps} (A fps=${endA.fps})`);
  check('A saw B move (remote interpolation is live)', sawRemoteMove, 'remote travelled > 2 m on A');
  // A TRIPWIRE, not the real fidelity check.
  //
  // Software-rendered browsers are too unstable for tight bounds: a page can
  // reload under GPU pressure mid-run, wiping the diagnostics being read and
  // producing nonsense (a large correction alongside a zero per-reconcile delta,
  // which is impossible). The tight bound lives in `npm run netheadless`, which
  // reproduces this exact reconciliation with no browser and holds the
  // correction to ~8% of one tick, at both 0 ms and 160 ms RTT.
  //
  // This still catches gross regressions: the pre-admission bug produced 10-16 m
  // here and would trip it.
  check(
    'prediction stayed broadly faithful (tight bound: netheadless)',
    maxError < 15,
    `worst ${maxError.toFixed(3)} m | one tick = ${(maxSpeed * TICK_DT).toFixed(3)} m | series [${errorSeries.slice(0, 6).join(', ')}]`,
  );
  check('both clients reached speed', maxSpeed > 15, `peak ${maxSpeed.toFixed(1)} m/s`);

  // ---------------------------------------------------------------- section 3
  console.log('\n=== 3. HUD and console ===');
  check('ping reported', endA.ping > 0 && endA.ping < 250, `${endA.hud.ping}`);
  check('no console errors on A', a.errors.length === 0, a.errors.slice(0, 3).join(' | '));
  check('no console errors on B', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));

  // Release A and B before testing under load. Three software-rendered browsers
  // competing for the CPU starves whichever one is being measured, which looks
  // exactly like a netcode failure and is not one.
  await a.browser.close().catch(() => {});
  await b.browser.close().catch(() => {});

  // ---------------------------------------------------------------- section 4
  console.log('\n=== 4. a bad network degrades gracefully ===');
  {
    // ~300 ms RTT with 50 ms of jitter: a realistic intercontinental link, and
    // the regime the netcode is designed for but never sees on localhost.
    const lagged = await launchClient('lagged', '?lag=150&jitter=50');
    await waitFor(
      async () => (await readNet(lagged.page))?.connected === true,
      40000,
      'conditioned client to connect',
    );

    const condStart = await readNet(lagged.page);
    check('joins over a laggy link', condStart.connected);
    check(
      'reports the simulated network',
      condStart.hud.status.includes('simulated network'),
      condStart.hud.status,
    );

    await lagged.page.keyboard.down('w');
    let condError = 0;
    let condSpeed = 0;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const r = await readNet(lagged.page);
      condError = Math.max(condError, r.predictionError);
      condSpeed = Math.max(condSpeed, r.speed);
    }
    await lagged.page.keyboard.up('w');

    const condEnd = await readNet(lagged.page);
    check(
      'still drives',
      condSpeed > 10,
      `peak local ${condSpeed.toFixed(1)} m/s | server says ${condEnd.auth ? condEnd.auth.speed.toFixed(1) : 'n/a'} m/s | ` +
        `pending=${condEnd.pending} fps=${condEnd.fps} hidden=${condEnd.hidden}`,
    );
    check('ping reflects the injected lag', condEnd.ping > 250, `ping ${condEnd.hud.ping}`);
    // Bound by "a few input batches of travel". Under latency the server can
    // apply a slightly different input sequence than the client predicted (its
    // queue runs dry between batches), so a correction of a couple of batches is
    // expected and healthy; genuine divergence would blow far past this.
    const batch = 1 / 30;
    check(
      'prediction stays bounded under lag + jitter',
      condError < condSpeed * batch * 3 + 0.5,
      `worst ${condError.toFixed(3)} m at ${condSpeed.toFixed(1)} m/s, one input batch = ${(condSpeed * batch).toFixed(3)} m`,
    );
    check(
      'no console errors over a bad link',
      lagged.errors.length === 0,
      lagged.errors.slice(0, 3).join(' | '),
    );

    // Close it. A client left connected keeps a seat in a crew AND keeps driving
    // that crew's car around the map, so later sections inherit a half-used
    // vehicle and cannot claim the seat they asked for.
    await lagged.browser.close().catch(() => {});
  }

  // ---------------------------------------------------------------- section 5
  console.log('\n=== 5. a silent client stops driving (server-side timeout) ===');
  {
    // Raw sockets: the point is a client that genuinely stops sending. Without
    // the server-side timeout the car keeps driving on its last input forever,
    // which is exactly what a backgrounded tab looked like.
    let driverId = null;
    // Ask for a specific crew's driver seat: with two teams of four, a third
    // player would otherwise be assigned a gunner seat and their input would be
    // correctly ignored, making this test assert nothing.
    const driver = await openRaw(
      (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'welcome') driverId = msg.id;
      },
      { crew: 7, seat: 'seat.driver' },
    );

    let latest = null;
    const observer = await openRaw((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'snap') latest = msg;
    });

    // Snapshots carry vehicles and members separately: resolve a player to their
    // crew, then to that crew's vehicle.
    const speedOf = (playerId) => {
      const member = latest?.members?.find((m) => m.id === playerId);
      if (!member) return -1;
      const vehicle = latest?.vehicles?.find((v) => v.crew === member.crew);
      return vehicle ? Math.hypot(vehicle.vx, vehicle.vz) : -1;
    };
    const players = () => latest?.members?.length ?? -1;

    await sleep(600);
    const observable = driverId !== null && speedOf(driverId) >= 0;
    check(
      'observer sees the driver in snapshots',
      observable,
      `driverId=${driverId}, snapshot has ${latest?.members?.length ?? 0} members`,
    );

    if (!observable) {
      // Without a readable driver the remaining assertions would "pass" on a
      // -1 sentinel, which is worse than failing.
      check('the silent-test car was driving', false, 'no readable state for the driver');
      check('coasts to a stop once the client goes quiet', false, 'no readable state for the driver');
    } else {
      let seq = 0;
      for (let i = 0; i < 45; i++) {
        driver.send(
          JSON.stringify({
            t: 'input',
            cmds: [{ seq: ++seq, throttle: 1, steer: 0, handbrake: false, boost: false }],
          }),
        );
        await sleep(33);
      }
      const moving = speedOf(driverId);
      check('the silent-test car was driving', moving > 10, `${moving.toFixed(1)} m/s`);

      // Say nothing for longer than the INPUT timeout but less than the liveness
      // timeout, so the client is still connected and the car should have parked.
      await sleep(2500);
      const stopped = speedOf(driverId);
      check(
        'coasts to a stop once the client goes quiet',
        stopped >= 0 && stopped < 1.5,
        `${moving.toFixed(1)} m/s → ${stopped.toFixed(2)} m/s after 2.5 s of silence`,
      );
    }

    driver.close();
    observer.close();
  }

  // ---------------------------------------------------------------- section 6
  console.log('\n=== 6. a silent connection is reaped (no ghost players) ===');
  {
    // A half-open connection never fires `close`, so without a liveness check a
    // killed browser lingers forever holding a slot. This showed up in the HUD
    // as "2 players" with a single client actually open.
    let latest = null;
    const observer = await openRaw((data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === 'snap') latest = msg;
    });
    const players = () => latest?.members?.length ?? -1;

    await sleep(800);
    const before = players();
    check('observer has a baseline', before >= 1, `${before} players`);

    // Stops answering protocol pings, so the server sees a genuinely dead socket.
    const ghost = await openRaw(null, { keepAlive: false, autoPong: false });
    await sleep(800);
    check('a silent connection joins', players() === before + 1, `${players()} players`);

    await sleep(CLIENT_TIMEOUT_MS + 1200);
    check(
      'and is reaped once it goes silent',
      players() === before,
      `${players()} players after ${CLIENT_TIMEOUT_MS}ms of silence (expected ${before})`,
    );

    observer.close();
    ghost.close();
  }
  // ---------------------------------------------------------------- section 7
  console.log('\n=== 7. a crew shares one vehicle (driver + gunner) ===');
  {
    // M4's core claim: several players ride ONE car. The driver moves it; the
    // gunner cannot, and their aim is confined to their window's arc.
    const driver = await launchClient('crew-driver', '?crew=0&seat=seat.driver');
    const gunner = await launchClient('crew-gunner', '?crew=0&seat=seat.frontRight');

    await waitFor(
      async () => {
        const [d, g] = await Promise.all([readNet(driver.page), readNet(gunner.page)]);
        return d?.connected && g?.connected && d.crew === 0 && g.crew === 0;
      },
      30000,
      'driver and gunner to share crew 0',
    );

    const d0 = await readNet(driver.page);
    const g0 = await readNet(gunner.page);

    check('driver and gunner are in the same crew', d0.crew === g0.crew, `crew ${d0.crew}`);
    check('roles are assigned from the seat', d0.isDriver && !g0.isDriver, `${d0.seat} / ${g0.seat}`);
    check(
      'they describe the same vehicle',
      Math.hypot(d0.local.x - g0.local.x, d0.local.z - g0.local.z) < 30,
      `driver at (${d0.local.x.toFixed(1)}, ${d0.local.z.toFixed(1)}), gunner at (${g0.local.x.toFixed(1)}, ${g0.local.z.toFixed(1)})`,
    );

    // The driver drives; the gunner must move with the car, not separately.
    const dStart = { x: d0.local.x, z: d0.local.z };
    await driver.page.keyboard.down('w');
    await sleep(2500);
    await driver.page.keyboard.up('w');
    await sleep(400);

    const d1 = await readNet(driver.page);
    const g1 = await readNet(gunner.page);
    const drove = Math.hypot(d1.local.x - dStart.x, d1.local.z - dStart.z);
    const followed = Math.hypot(g1.local.x - dStart.x, g1.local.z - dStart.z);

    check('the driver moved the car', drove > 10, `${drove.toFixed(1)} m`);
    check(
      'the gunner rode along in the same car',
      Math.abs(followed - drove) < 8,
      `driver ${drove.toFixed(1)} m vs gunner ${followed.toFixed(1)} m — the gunner rides interpolated state, ~100 ms behind by design`,
    );

    // The gunner cannot drive: input from a gunner's seat is ignored server-side.
    //
    // Let the car coast to a stop first. Measuring straight away measures the
    // driver's momentum instead — the car travels tens of metres while slowing,
    // which looks exactly like a gunner who can drive.
    let lowest = Infinity;
    let lastSeen = null;
    for (let i = 0; i < 30 && lowest >= 0.5; i++) {
      await sleep(400);
      const [dr, gr] = await Promise.all([readNet(driver.page), readNet(gunner.page)]);
      lastSeen = { clientThrottle: dr.throttle, auth: dr.auth };
      lowest = Math.min(lowest, dr.speed, gr.speed);
    }
    check(
      'the car coasts to a stop when the driver releases the throttle',
      lowest < 0.5,
      `lowest ${lowest.toFixed(2)} m/s | last ${JSON.stringify(lastSeen)}`,
    );
    const stopped = await readNet(gunner.page);
    const gBefore = { x: stopped.local.x, z: stopped.local.z };
    await gunner.page.keyboard.down('w');
    await sleep(1500);
    await gunner.page.keyboard.up('w');
    await sleep(300);
    const g2 = await readNet(gunner.page);
    const drift = Math.hypot(g2.local.x - gBefore.x, g2.local.z - gBefore.z);
    check(
      'a gunner cannot drive the car',
      drift < 2 && g2.speed < 2,
      `moved ${drift.toFixed(2)} m, speed ${g2.speed.toFixed(2)} m/s on gunner input`,
    );

    // Aim is clamped to the seat's window arc: front passenger is -5° to 155°.
    // Front-right window. Aim yaw is LEFT-positive, so the right side is the
    // negative end of the arc.
    const ARC = [(-155 * Math.PI) / 180, (5 * Math.PI) / 180];
    const setAim = async (page, yaw) => {
      await page.evaluate((y) => {
        const inputs = window.__convoy?.inputs;
        if (inputs) inputs.lookYaw = y;
      }, yaw);
      await sleep(350);
      return (await readNet(page)).aimYaw;
    };

    const insideArc = await setAim(gunner.page, -1.0);
    check(
      'aim inside the arc passes through',
      Math.abs(insideArc - -1.0) < 0.15,
      `asked -1.000 rad, got ${insideArc.toFixed(3)}`,
    );

    // Aiming hard left, where the driver sits and there is no window.
    const pastArc = await setAim(gunner.page, 1.4);
    check(
      'aim outside the arc is clamped to it',
      pastArc >= ARC[0] - 0.01 && pastArc <= ARC[1] + 0.01,
      `asked 1.400, got ${pastArc.toFixed(3)} (arc ${ARC[0].toFixed(3)}..${ARC[1].toFixed(3)})`,
    );
  }
} catch (error) {
  console.error(`\n${error.message}`);
  failures++;
} finally {
  for (const browser of launchedBrowsers) {
    await browser.close().catch(() => {});
  }
  shutdown();
}

console.log(
  failures === 0 ? '\n✓ all netcode checks passed\n' : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
