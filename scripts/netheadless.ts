/**
 * Headless prediction/reconciliation harness.
 *
 * The browser tests are too noisy to root-cause a subtle netcode fault in: under
 * software rendering a page can stall, reload or be reaped mid-run, which wipes
 * the very diagnostics you are reading. This reproduces the client's netcode
 * exactly — same shared simulation, same reconcile, same correction decay — with
 * no browser, no rendering, and no frame-rate variance.
 *
 * If a fault reproduces here it is real netcode. If it does not, it lives in the
 * browser environment.
 *
 *   npm run netheadless
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { NET, TICK, VEHICLE_CLASSES } from '../src/shared/config';
import { SPAWNS } from '../src/shared/arena';
import {
  createVehicle,
  resetVehicle,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../src/shared/vehicle';
import { clamp, wrapAngle } from '../src/shared/math';

const PORT = Number(process.env.PORT ?? 8199);
const RUN_SECONDS = Number(process.env.RUN_SECONDS ?? 8);
const LATENCY = Number(process.env.LATENCY ?? 0);
const URL = `ws://localhost:${PORT}/ws`;

type InputCmd = VehicleInput & { seq: number };

// ------------------------------------------------------------------- server

// Own process group: killing `npx` alone leaves the node server holding the
// port (and this script's event loop) alive. See matchtest's `stop`.
const server = spawn('npx', ['tsx', 'src/server/server.ts'], {
  detached: true,
  // Prediction is what is under test; hold the match live so the harness is not
  // also waiting out a lobby it does not exercise.
  env: { ...process.env, PORT: String(PORT), DEV_ASSIGN: '1', MATCH_FORCE_LIVE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', (buf) => {
    for (const line of String(buf).split('\n')) if (line.trim()) serverLog.push(line.trim());
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- client

const spec = VEHICLE_CLASSES.suv;
const local: VehicleState = createVehicle(0, 0, 0, 0, spec);

let seq = 0;
let ticks = 0;
let ticksSinceSend = 0;
let pending: InputCmd[] = [];
let sendQueue: InputCmd[] = [];
let crewId = -1;
let connected = false;

const correction = { x: 0, z: 0 };
let maxDelta = 0;
let maxCorrection = 0;
let maxPending = 0;
let minServerQueue = 99;
const correctionSeries: number[] = [];
const deltaSeries: number[] = [];

let socket: WebSocket;
const seen: Record<string, number> = {};
let welcomeCrew: number | null = null;
let attempts = 0;

function connect(): void {
  attempts++;
  socket = new WebSocket(URL);
  attach(socket);
  socket.on('error', () => {
    if (!connected && attempts < 40) setTimeout(connect, 500);
  });
  socket.on('close', () => {
    if (!connected && attempts < 40) setTimeout(connect, 500);
  });
}

/** Optional one-way delay, so the harness can be run with latency too. */
const delayed = (fn: () => void) => {
  if (LATENCY <= 0) fn();
  else setTimeout(fn, LATENCY);
};

function attach(socket: WebSocket): void {
  socket.on('open', () => {
    if (attempts > 1) process.stdout.write(`  connected on attempt ${attempts}\n`);
    delayed(() => socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew: 0, seat: 'seat.driver' })));
  });

  socket.on('message', (data) => {
  const msg = JSON.parse(String(data));
  seen[msg.t] = (seen[msg.t] ?? 0) + 1;
  if (msg.t === 'welcome') welcomeCrew = msg.crew;

  if (msg.t === 'welcome') {
    crewId = msg.crew;
    connected = true;
    const spawn = SPAWNS[crewId % SPAWNS.length];
    resetVehicle(local, spawn.x, spawn.y, spawn.z, spawn.yaw);
    seq = 0;
    pending = [];
    sendQueue = [];
    return;
  }

  if (msg.t !== 'snap' || !connected) return;
  const mine = msg.vehicles.find((v: { crew: number }) => v.crew === crewId);
  if (!mine) return;

  minServerQueue = Math.min(minServerQueue, mine.queued);

  // --- exactly what NetClient.reconcile does ---
  const beforeX = local.pos.x;
  const beforeZ = local.pos.z;

  local.pos.x = mine.x;
  local.pos.y = mine.y;
  local.pos.z = mine.z;
  local.vel.x = mine.vx;
  local.vel.y = mine.vy;
  local.vel.z = mine.vz;
  local.yaw = mine.yaw;
  local.onGround = mine.onGround;
  local.forwardSpeed = mine.forwardSpeed;

  pending = pending.filter((c) => c.seq > msg.ackSeq);
  for (const cmd of pending) stepVehicle(local, cmd, TICK.dt);

  const delta = Math.hypot(beforeX - local.pos.x, beforeZ - local.pos.z);
  maxDelta = Math.max(maxDelta, delta);
  deltaSeries.push(Number(delta.toFixed(4)));

  correction.x += beforeX - local.pos.x;
  correction.z += beforeZ - local.pos.z;
});

}

connect();

// --------------------------------------------------------------------- loop

// Drift-corrected fixed step, mirroring the client's accumulator.
let accumulator = 0;
let last = performance.now();

const step = () => {
  const now = performance.now();
  let elapsed = (now - last) / 1000;
  last = now;
  if (elapsed > 0.25) elapsed = 0.25;
  accumulator += elapsed;

  let steps = 0;
  while (accumulator >= TICK.dt && steps < 80) {
    const input: VehicleInput = { throttle: 1, steer: 0, handbrake: false, boost: false };
    seq++;
    const cmd: InputCmd = { ...input, seq };
    pending.push(cmd);
    sendQueue.push(cmd);
    maxPending = Math.max(maxPending, pending.length);
    stepVehicle(local, input, TICK.dt);

    if (++ticksSinceSend >= 2) {
      ticksSinceSend = 0;
      if (socket.readyState === 1 && connected) {
        const batch = sendQueue;
        sendQueue = [];
        delayed(() => socket.send(JSON.stringify({ t: 'input', cmds: batch })));
      }
    }

    const decay = Math.exp(-NET.correctionRate * TICK.dt);
    correction.x *= decay;
    correction.z *= decay;
    const magnitude = Math.hypot(correction.x, correction.z);
    maxCorrection = Math.max(maxCorrection, magnitude);
    if (ticks % 5 === 0) correctionSeries.push(Number(magnitude.toFixed(3)));

    accumulator -= TICK.dt;
    steps++;
    ticks++;
  }
  if (accumulator > TICK.dt * 80) accumulator = 0;
};

const timer = setInterval(step, 1000 / 120);

// -------------------------------------------------------------------- report

setTimeout(() => {
  clearInterval(timer);
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  socket.close();

  const worstCorrection = Math.max(...correctionSeries, 0);
  const worstDelta = maxDelta;
  const oneTick = Math.abs(local.forwardSpeed) * TICK.dt;

  console.log('\n=== headless prediction harness ===');
  console.log(`  latency ${LATENCY} ms · ${ticks} ticks simulated`);
  console.log(`  worst reconcile delta   ${worstDelta.toFixed(4)} m`);
  console.log(`  worst correction        ${worstCorrection.toFixed(3)} m`);
  console.log(`  one tick of travel      ${oneTick.toFixed(3)} m`);
  console.log(`  max pending inputs      ${maxPending}`);
  console.log(`  min server queue depth  ${minServerQueue}`);
  console.log(`  correction series       [${correctionSeries.slice(-24).join(', ')}]`);
  console.log(`  messages seen           ${JSON.stringify(seen)} welcomeCrew=${welcomeCrew}`);

  const bad = worstCorrection > oneTick * 2 + 0.1;
  console.log(
    bad
      ? '\n✗ prediction drifted beyond two ticks of travel\n'
      : '\n✓ prediction stayed within two ticks of travel\n',
  );
  process.exit(bad ? 1 : 0);
}, RUN_SECONDS * 1000);

// Give the server a moment to boot before the client connects.
//
// No hello is sent here: `attach` sends it on open, and the duplicate that used
// to sit here made the harness join twice. It only showed up when the test
// scripts were brought under the typechecker, which could see that `socket` was
// not provably assigned at this point.
await sleep(1200);
