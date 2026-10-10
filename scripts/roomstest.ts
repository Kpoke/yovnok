/**
 * Rooms and rejoin, end to end against a real server.
 *
 *   - Several matches at once (`rooms.ts`): a player pressing PLAY while the
 *     only room is mid-match gets a NEW room, not "match full".
 *   - Rejoin: a player who drops mid-match has their car held (bot-driven);
 *     the same browser token sees it via `held?` and gets it back on `hello`.
 *   - Private rooms: a code to share, no bots, the host starts the match, a
 *     latecomer waits while it is live, a wrong code is refused.
 *   - The player limit: past MAX_PLAYERS, PLAY is told to wait ("busy").
 *   - An idle extra room is closed again.
 *
 *   npm run roomstest
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 8699;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++;
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

// Own process group, so the node server under `npx` is stopped too.
const server = spawn('npx', ['tsx', 'src/server/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    PORT: String(PORT),
    MODE: 'solo',
    MATCH_COUNTDOWN_SECONDS: '1',
    SOLO_MIN_PLAYERS: '1',
    // Short, so the idle check below does not wait out a held car (the rejoin
    // step takes about a second).
    REJOIN_SECONDS: '8',
    MAX_PLAYERS: '5',
    MAX_ROOMS: '8',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  let partial = '';
  stream?.on('data', (buf) => {
    const lines = (partial + String(buf)).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) log.push(line.trim());
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

type Client = {
  ws: WebSocket;
  welcome: { crew: number; resumed?: boolean } | null;
  phase: string | null;
  held: number | null;
  reject: string | null;
  busy: { reason: string; online: number; capacity: number } | null;
  room: { code: string; host: boolean; players: string[]; map: string } | null;
  map: string | null;
  roster: Record<string, string> | null;
};

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c: Client = {
      ws,
      welcome: null,
      phase: null,
      held: null,
      reject: null,
      busy: null,
      room: null,
      map: null,
      roster: null,
    };
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.t === 'welcome') c.welcome = m;
      else if (m.t === 'snap') c.phase = m.match.phase;
      else if (m.t === 'held') c.held = m.seconds;
      else if (m.t === 'reject') c.reject = m.reason;
      else if (m.t === 'busy') c.busy = m;
      else if (m.t === 'room') c.room = m;
      else if (m.t === 'map') c.map = m.id;
      else if (m.t === 'roster') c.roster = m.names;
    });
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}
const hello = (c: Client, token: string, room?: string, name = 'tester'): void =>
  c.ws.send(JSON.stringify({ t: 'hello', cls: 'solo', name, token, room }));
const health = async (): Promise<{ rooms: number; phases: string[] }> =>
  (await (await fetch(`http://localhost:${PORT}/healthz`)).json()) as { rooms: number; phases: string[] };

try {
  await until(() => log.some((l) => l.includes('listening on')), 20_000);

  console.log('\n=== abuse cannot take the server down ===');
  {
    // One oversized message from the TITLE screen (before joining) used to
    // crash the whole process: an unhandled socket 'error'.
    const big = await connect();
    const closed = new Promise<number>((r) => big.ws.once('close', (code) => r(code)));
    big.ws.send('x'.repeat(64 * 1024));
    check('an oversized message closes that socket', (await closed) === 1009);
    const flood = await connect();
    const flooded = new Promise<boolean>((r) => {
      flood.ws.once('close', () => r(true));
      setTimeout(() => r(false), 3000);
    });
    for (let i = 0; i < 600; i++) flood.ws.send('{"t":"ping","id":1}');
    check('a message flood closes that socket', await flooded);
    const alive = await fetch(`http://localhost:${PORT}/healthz`).then((r) => r.ok).catch(() => false);
    check('and the server is still up', alive);
  }

  console.log('\n=== several matches at once ===');
  const a = await connect();
  hello(a, 'token-alpha-0001');
  check('the first player is welcomed', await until(() => a.welcome !== null, 10_000));
  check('and their match goes live', await until(() => a.phase === 'live', 15_000), `phase ${a.phase}`);
  const b = await connect();
  hello(b, 'token-bravo-0002');
  await until(() => b.welcome !== null || b.reject !== null, 10_000);
  check('a player arriving mid-match is placed, not turned away', b.welcome !== null, b.reject ?? '');
  const h = await health();
  check('in a second room', h.rooms === 2, JSON.stringify(h));

  console.log('\n=== rejoin ===');
  const crewBefore = a.welcome?.crew;
  a.ws.close();
  await sleep(800);
  const back = await connect();
  back.ws.send(JSON.stringify({ t: 'held?', token: 'token-alpha-0001' }));
  await until(() => back.held !== null, 5000);
  check('the title is told the left car is held', (back.held ?? 0) > 0, `${back.held?.toFixed(1)} s`);
  const stranger = await connect();
  stranger.ws.send(JSON.stringify({ t: 'held?', token: 'token-nobody-9999' }));
  await until(() => stranger.held !== null, 5000);
  check('another browser is told nothing is held', stranger.held === 0);
  hello(back, 'token-alpha-0001');
  await until(() => back.welcome !== null, 10_000);
  check('REJOIN hands back the car', back.welcome?.resumed === true, JSON.stringify(back.welcome));
  check('the same car', back.welcome?.crew === crewBefore, `crew ${back.welcome?.crew} (was ${crewBefore})`);

  console.log('\n=== private rooms ===');
  const host = await connect();
  hello(host, 'token-host-00001', 'new', 'HOSTY');
  await until(() => host.room !== null, 10_000);
  const code = host.room?.code ?? '';
  check('creating a room gives a five-letter code', /^[A-Z]{5}$/.test(code), code);
  check('the creator hosts it', host.room?.host === true);
  check('and is told its map', host.map === 'stadium', String(host.map));
  const wrong = await connect();
  hello(wrong, 'token-wrong-0001', 'ZZZZZ');
  await until(() => wrong.reject !== null, 5000);
  check('a wrong code is refused', wrong.reject === 'no such room', String(wrong.reject));
  const friend = await connect();
  hello(friend, 'token-friend-001', code.toLowerCase(), 'FRIEND');
  await until(() => (host.room?.players.length ?? 0) === 2 && friend.room !== null, 10_000);
  check('a friend joins with the code (any case)', friend.welcome !== null && host.room?.players.length === 2);
  check('the friend does not host', friend.room?.host === false);
  await sleep(1500);
  check('no bots: the roster is the two players', Object.keys(friend.roster ?? {}).length === 2, JSON.stringify(friend.roster));
  check('the match waits for the host', friend.phase === 'lobby', String(friend.phase));
  friend.ws.send(JSON.stringify({ t: 'roomStart' }));
  await sleep(800);
  check('only the host can start it', friend.phase === 'lobby', String(friend.phase));
  host.ws.send(JSON.stringify({ t: 'roomStart' }));
  check('the host starts it', await until(() => friend.phase === 'live', 10_000), String(friend.phase));
  const late = await connect();
  hello(late, 'token-late-00001', code);
  await until(() => late.busy !== null, 5000);
  check('a latecomer waits while the match is live', late.busy?.reason === 'live', JSON.stringify(late.busy));
  check('private rooms count in health', (await health() as { private?: number }).private === 1);

  console.log('\n=== the player limit ===');
  // back, b, host, friend = 4 of 5.
  const fifth = await connect();
  hello(fifth, 'token-fifth-0001');
  await until(() => fifth.welcome !== null || fifth.busy !== null, 10_000);
  check('the fifth player gets in', fifth.welcome !== null, JSON.stringify(fifth.busy));
  const sixth = await connect();
  hello(sixth, 'token-sixth-0001');
  await until(() => sixth.busy !== null || sixth.welcome !== null, 10_000);
  check('the sixth is asked to wait', sixth.busy?.reason === 'full' && sixth.welcome === null, JSON.stringify(sixth.busy));
  check('and told the count', sixth.busy?.online === 5 && sixth.busy?.capacity === 5, JSON.stringify(sixth.busy));
  fifth.ws.close();
  await sleep(600);
  hello(sixth, 'token-sixth-0001');
  await until(() => sixth.welcome !== null, 10_000);
  check('and gets in once a seat frees up', sixth.welcome !== null);

  console.log('\n=== idle rooms close ===');
  for (const c of [back, b, stranger, host, friend, wrong, late, sixth]) c.ws.close();
  // A player who drops mid-match has their car held (REJOIN_SECONDS), so a
  // room is idle only after that; the sweep then runs within 10 s.
  const closed = await until(() => log.filter((l) => l.includes('closed an idle room')).length >= 2, 40_000);
  check('empty extra rooms are closed', closed);
  check('one room keeps running', (await health()).rooms === 1);
} catch (error) {
  check(`roomstest threw: ${String(error)}`, false);
  for (const line of log.slice(-20)) console.log(`    server: ${line}`);
} finally {
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

console.log(failures === 0 ? '\n✓ all room checks passed\n' : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
