/**
 * M2 entry point — authoritative multiplayer.
 *
 * The local car is predicted (drawn from `net.renderState`, which carries any
 * un-settled correction), remote cars are interpolated from buffered snapshots.
 * Our car leaves skid marks; remote cars do not yet.
 *
 * The fixed-step simulation loop is unchanged from M1, which was the point of
 * building it that way: prediction is only possible because the client and
 * server run identical simulation code at an identical timestep.
 */

import { createGltfLoader } from './assetLoaders';
import type { CreditsSection } from '../shared/credits';
import * as THREE from 'three';
import { CAMERA, COMBAT, LIGHTING_PRESETS, TICK, VEHICLE, ZONE } from '../shared/config';
import { MAPS, SPAWNS, useMap } from '../shared/arena';
import { DEFAULT_MAP, isMapId, type MapId } from '../shared/mapIds';
import { World } from './world';
import { localToWorld, NEUTRAL_INPUT, stepVehicle, type VehicleInput } from '../shared/vehicle';
import { relativeAim, vehiclePointWorld } from '../shared/combat';
import { WS_PATH } from '../shared/protocol';
import { clampToArc, seatById, seatsFor } from '../shared/crews';
import { clamp, wrapAngle } from '../shared/math';
import { WEAPONS } from '../shared/weapons';
import { outsideZone } from '../shared/zone';
import { packLook, unpackLook, type CosmeticLook } from '../shared/cosmetics';
import { applyMatch, loadProfile, setLook } from './profile';
import { Garage } from './garage';
import { buildCrates } from './buildCrates';
import { buildZone } from './buildZone';
import { buildSky } from './sky';
import { Explosions } from './explosions';
import { DamageFx } from './damageFx';
import { CarLights } from './carLights';
import { DriveFx, groundAt } from './driveFx';
import { callsignAllowed, randomCallsign, sanitiseCallsign } from '../shared/callsign';
import { FramePerf } from './perf';
import { Lighting, loadQuality, QUALITIES, saveQuality } from './lighting';
import { WeaponFx } from './weaponFx';
import { GameAudio } from './audio';
import { Music } from './music';
import { buildVehicle, type VehicleRig } from './vehicle/buildVehicle';
import { GltfPartLibrary, toLod } from './vehicle/gltfPartLibrary';
import { allPartRequests, proceduralPartLibrary, type PartLibrary } from './vehicle/partLibrary';
import { CameraRig } from './camera';
import { RoomUi } from './roomUi';
import { Hud } from './hud';
import { Input } from './input';
import { NetClient, readCrewRequest, readVehicleClass } from './net';
import { readConditions } from './netCondition';
import { SkidMarks } from './skidMarks';
import { Tracers } from './tracers';

// ------------------------------------------------------------------ renderer

const canvas = document.getElementById('game') as HTMLCanvasElement;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// Soft-filtered shadows from one key light: hard-edged shadows are the single
// biggest "unfinished" tell in a lit scene. (Tone mapping lives in Lighting.)
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
// A flat background is the fallback; the dome below is what you actually see.
// The map's own sky, fog and light replace these once it is built (World).
scene.background = new THREE.Color(LIGHTING_PRESETS.floodlitNight.sky.background);
scene.fog = new THREE.Fog(LIGHTING_PRESETS.floodlitNight.sky.fog, 300, 820);

/**
 * Image-based lighting, first pass: the sky dome as the environment, so PBR
 * materials have something to reflect from the first frame. The night HDRI
 * replaces it once loaded (Lighting.loadEnvironment, behind the loading screen).
 */
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(buildSky());
  const environment = pmrem.fromScene(envScene, 0.04);
  scene.environment = environment.texture;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(
  CAMERA.fov,
  window.innerWidth / window.innerHeight,
  // Close enough that a window camera 0.4 m outside the body does not clip it.
  0.15,
  // Far enough to clear the 800 m map, the sky dome, and the fog.
  1400,
);

// -------------------------------------------------------------------- lights

// Floodlit night: HDRI environment, a key and three fills, bloom (lighting.ts).
const lighting = new Lighting(renderer, scene, camera, loadQuality());

// ------------------------------------------------------------------ network

const hud = new Hud();
// Frame-time breakdown in the F3 overlay: where a missed refresh went.
const perf = new FramePerf(renderer, document.getElementById('perf'));

// Network conditions come from the URL so adverse networks can be reproduced:
//   ?lag=120&jitter=40&loss=0.05
// And the vehicle class: ?car=coupe. Defaults to the 4-crew SUV.
const net = new NetClient(
  (status) => hud.setStatus(status),
  readConditions(location.search),
  readVehicleClass(location.search),
);
const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
// Crew/seat requests are dev-only: the server ignores them unless it is running
// with DEV_ASSIGN=1, so they cannot be used to pick your own team.
// The game socket's address comes from the server (/config.json): in
// production it is a direct address that skips the CDN, which halves the round
// trip; anywhere else (development, a missing or slow answer) it is this page's
// own origin.
{
  const sameOrigin = `${wsProtocol}://${location.host}${WS_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  fetch(`/config.json?t=${encodeURIComponent(net.sessionToken)}`, { signal: controller.signal, cache: 'no-store' })
    .then((r) => (r.ok ? (r.json() as Promise<{ wsUrl?: string | null }>) : null))
    .catch(() => null)
    .then((config) => {
      clearTimeout(timeout);
      const wsUrl = config?.wsUrl && /^wss?:\/\//.test(config.wsUrl) ? config.wsUrl : sameOrigin;
      net.connect(wsUrl, readCrewRequest(location.search));
    });
}
hud.onReady(() => net.sendReady());

/**
 * Assets resolve once every part the game needs has loaded. PLAY waits on this
 * behind a loading screen, so a match never starts with half a car: download
 * size is not a constraint, being fully loaded before the whistle is.
 */
let markAssetsReady!: () => void;
const assetsReady = new Promise<void>((resolve) => (markAssetsReady = resolve));
/** When the loading screen went up, so a join that never lands can give up. */
let loadingSince = 0;
/** Seconds of continuous driving, for the dynamic-resolution warm-up. */
let drivingFor = 0;
/**
 * The in-game menu is a plain toggle: Esc (or Start) opens and closes it,
 * whether or not the mouse is locked. It used to be inferred from pointer-lock
 * state ("had the lock, lost it"), which only worked if the lock happened to be
 * held — Esc did nothing for a player whose lock the browser had refused.
 */
let menuOpen = false;
/** When the menu last changed, so one Esc press cannot both open and close it. */
let menuChangedAt = 0;
function setMenu(open: boolean): void {
  if (open === menuOpen) return;
  menuOpen = open;
  menuChangedAt = performance.now();
}

/**
 * Menus with a gamepad: D-pad up/down moves between the visible menu items, A
 * presses the focused one, B goes back (closes the in-game menu, or the open
 * panel on the title). Focus is real DOM focus, so it is styled like hover.
 */
function padNavigate(events: Array<'up' | 'down' | 'confirm' | 'back'>): void {
  if (events.length === 0) return;
  const menu = hud.paused ? document.getElementById('pause') : net.connected ? null : document.getElementById('join');
  if (!menu) return;
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')].filter(
    (b) => !b.hidden && !b.disabled && b.offsetParent !== null,
  );
  if (items.length === 0) return;
  for (const event of events) {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event === 'up') items[at <= 0 ? items.length - 1 : at - 1].focus();
    else if (event === 'down') items[at < 0 || at >= items.length - 1 ? 0 : at + 1].focus();
    else if (event === 'confirm') (at >= 0 ? items[at] : items[0]).click();
    else if (event === 'back') {
      if (hud.paused) resumeFromMenu();
      else menu.querySelector<HTMLButtonElement>('.menu-item.open')?.click();
    }
  }
}
const byIdText = (id: string, text: string): void => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};
let assetsLoaded = false;
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => {
  // Say WHAT is loading, in words, not a file name (some are worker blobs).
  const name = /\/vehicles\//.test(url)
    ? 'vehicles'
    : /\/materials\//.test(url)
      ? 'arena surfaces'
      : /\/props\//.test(url)
        ? 'set dressing'
        : /\/hdri\//.test(url)
          ? 'night sky'
          : /\/(audio|music)\//.test(url)
            ? 'sound'
            : 'broadcast';
  // First load: the stand-by card. (Anything after that is small and quick.)
  if (!assetsLoaded) hud.setStandby(loaded / total, `loading ${name}`);
  if (loadingSince) hud.setLoading(loaded / total, `loading ${name}`);
};

// ---- callsign: chosen or generated, remembered in this browser ----
const CALLSIGN_KEY = 'convoy.callsign';
const storage = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null): void => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode: it just will not be remembered.
    }
  },
};
let callsign = sanitiseCallsign(storage.get(CALLSIGN_KEY)) || randomCallsign();
storage.set(CALLSIGN_KEY, callsign);
const applyCallsign = (name: string): void => {
  callsign = name;
  net.callsign = name;
  hud.setCallsign(name);
};
applyCallsign(callsign);
hud.onCallsign((raw) => {
  const clean = sanitiseCallsign(raw);
  // Same filter as the server, so a blocked name is refused here — with a
  // reason — rather than silently swapped for a generated one in the match.
  hud.setCallsignError(clean && !callsignAllowed(clean) ? "that callsign isn't allowed" : '');
  if (!clean || !callsignAllowed(clean)) return;
  storage.set(CALLSIGN_KEY, clean);
  callsign = clean;
  net.callsign = clean;
  byIdText('callsign-show', clean);
});
hud.onRandomCallsign(() => {
  const fresh = randomCallsign();
  storage.set(CALLSIGN_KEY, fresh);
  applyCallsign(fresh);
});
hud.setNames(net.names);

// Phones and tablets: on-screen controls (touch.ts), played in landscape and
// full screen. A tablet with a keyboard and mouse attached reports a fine
// pointer too, and plays as a computer.
const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
if (touchOnly) document.body.classList.add('touch');
/** Full screen, and landscape where the browser lets a page lock it (Android). */
function goFullscreen(): void {
  const root = document.documentElement;
  if (document.fullscreenElement || typeof root.requestFullscreen !== 'function') return;
  root
    .requestFullscreen({ navigationUI: 'hide' })
    .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => undefined);
}
window.addEventListener('gamepadconnected', () => {
  hud.showTip('Controller connected — RT drive · LT brake · RB guns · LB RPG · Start menu', 6);
});

// Rejoin: a car left mid-match is held (bot-driven) by the server for a while;
// the network layer asks on connect, and PLAY becomes REJOIN while it lasts.

// Joining is explicit: the page opens a menu, and only PLAY places us (or
// creating / joining a private room).
function startJoin(room?: string): void {
  if (touchOnly) goFullscreen();
  // Anonymous statistics: how people play (input device and quality preset).
  net.clientInfo = {
    input: inputs.padActive || inputs.padConnected ? 'gamepad' : touchOnly ? 'touch' : 'mouse',
    quality: lighting.current,
  };
  setSound(true); // carry the menu's music into the lobby
  loadingSince = performance.now();
  hud.setLoading(0, 'loading');
  void assetsReady.then(() => {
    hud.setLoading(1, room ? 'opening the room' : 'joining the broadcast');
    net.join(room);
  });
}
hud.onJoin(() => startJoin());

// Private rooms: the drawer on the title and the room's own lobby.
const roomUi = new RoomUi();
roomUi.handlers({
  join: (room) => startJoin(room),
  pickMap: (map) => net.sendRoomMap(map),
  start: () => net.sendRoomStart(),
  leave: () => net.leave(),
});
{
  // An invite link: ?room=CODE opens the drawer with the code filled in.
  const invited = new URLSearchParams(location.search).get('room');
  if (invited) roomUi.prefill(invited);
}

/** The last map whose downloads were started early. */
let prefetched: MapId | null = null;

hud.onCancelWait(() => {
  net.cancelJoin();
  loadingSince = 0;
  hud.setLoading(null);
});

// Diagnostics (FPS, ping, jitter…) are hidden until asked for. F3 is the usual
// key; ` is there because F3 is Mission Control on a Mac keyboard. Remembered
// for this TAB only (sessionStorage): it survives a reload while debugging, but a
// fresh visit always starts clean — it used to stick on forever once opened.
try {
  localStorage.removeItem('convoy.debug'); // the old, permanent setting
  if (sessionStorage.getItem('convoy.debug') === '1') document.body.classList.add('debug-on');
} catch {
  // Storage disabled: debug simply starts off.
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'F3' && e.code !== 'Backquote') return;
  e.preventDefault();
  const on = document.body.classList.toggle('debug-on');
  try {
    sessionStorage.setItem('convoy.debug', on ? '1' : '0');
  } catch {
    // Not worth failing over.
  }
});

// Credits: every third-party asset, generated from assets.json by
// `npm run licensecheck -- --write` — the same record the licence gate checks.
void fetch('/credits.json')
  .then((r) => r.json() as Promise<{ sections: CreditsSection[] }>)
  .then(({ sections }) => hud.setCredits(sections))
  .catch(() => hud.setCredits([]));
// Any click can also unlock audio, in case sound was never toggled on.
canvas.addEventListener('click', () => audio.init());

// --------------------------------------------------------------- world & car

const skidMarks = new SkidMarks();
scene.add(skidMarks.mesh);

const tracers = new Tracers();
scene.add(tracers.object);

/**
 * Cosmetics (M12). Paint, wheels and roof kits are chosen in the menu, stored
 * per browser, and relayed by the server so everyone sees the same car. They are
 * purely visual: the simulation never reads a look.
 */
let profile = loadProfile();
// Only PAINT is offered: wheel styles and roof kits were built for the old
// procedural cars and do nothing on the realistic models (no roof mount, one
// wheel model). The look format keeps the fields, pinned to their defaults, so
// an old saved choice cannot leave the car in a state the garage cannot show.
const paintOnly = (look: CosmeticLook): CosmeticLook => ({ ...look, wheels: 0, roof: 0 });
profile = setLook(profile, paintOnly(profile.look));
const lookKey = (l: ReturnType<typeof unpackLook>): string => `${l.livery}/${l.wheels}/${l.roof}`;
net.look = packLook(profile.look);
let localLookKey = lookKey(profile.look);

// The garage lives in the join menu. Choosing a look updates the local rig at
// once (the loop below rebuilds it) and is sent with the next `hello`.
let garage: Garage | null = null;
const garageRoot = document.getElementById('cosmetics');
if (garageRoot) {
  garage = new Garage(garageRoot, profile);
  garage.build();
  garage.onLook((look) => {
    profile = setLook(profile, paintOnly(look));
    net.look = packLook(profile.look);
    garage?.render(profile);
  });
}

/** One record per results screen, so a long results phase is not counted twice. */
let resultsRecorded = false;

/**
 * Where vehicle geometry comes from.
 *
 * glTF assets are used when a manifest describes them; otherwise the game runs
 * on procedural parts. Anything the manifest cannot satisfy falls back
 * individually, so a half-finished asset set never leaves a car missing a wheel.
 */
/** One loader for every built asset: meshopt geometry, KTX2 textures. */
const gltfLoader = createGltfLoader(renderer);
const partLibrary: PartLibrary = new GltfPartLibrary(
  '/assets/vehicles/manifest.json',
  proceduralPartLibrary,
  gltfLoader,
);
// The map: arena, scenery, materials and time of day; it changes with the
// match's map (see the frame loop).
const world = new World(scene, lighting, gltfLoader);
// Everything the title needs, loaded behind the stand-by card: vehicle parts
// and the first map.
// (Development: ?map=<id> shows that map on the title, to look at it.)
const previewMap = import.meta.env.DEV ? new URLSearchParams(location.search).get('map') : null;
await Promise.all([partLibrary.prepare(allPartRequests()), world.show(isMapId(previewMap) ? previewMap : DEFAULT_MAP)]);
assetsLoaded = true;
hud.setStandby(1, 'going live');
markAssetsReady();

// The local rig is built from the class we asked for; it is rebuilt if the
// server assigns something different.
let localCar = buildVehicle(net.local.spec, profile.look, partLibrary);
scene.add(localCar.root);
let localCarClass = net.local.spec.id;

/** Remote cars, keyed by crew id. Created and destroyed as crews come and go. */
const remoteCars = new Map<number, VehicleRig>();
/** The look each remote rig was built with, so a paint change rebuilds it. */
const remoteLookKeys = new Map<number, string>();

const inputs = new Input();
inputs.attach(canvas);
if (touchOnly) inputs.attachTouch();

/**
 * Aim assist, touch only: a thumb is far less precise than a mouse, so when a
 * car is near the crosshair the view eases toward it. Gentle (it never snaps)
 * and only within a narrow cone, so it helps aim rather than aiming for you.
 */
const assistForward = new THREE.Vector3();
const assistTo = new THREE.Vector3();
function aimAssist(dt: number): void {
  camera.getWorldDirection(assistForward);
  let best: { yaw: number; pitch: number } | null = null;
  let bestScore = Infinity;
  for (const rig of remoteCars.values()) {
    if (!rig.root.visible) continue;
    assistTo.copy(rig.root.position).setY(rig.root.position.y + 0.8).sub(camera.position);
    const distance = assistTo.length();
    if (distance < 6 || distance > 160) continue;
    assistTo.divideScalar(distance);
    const cos = assistForward.dot(assistTo);
    if (cos < Math.cos(0.17)) continue; // ~10° cone
    // Signed horizontal angle: positive = target to the left.
    const yaw = Math.atan2(assistForward.x * assistTo.z - assistForward.z * assistTo.x, assistForward.x * assistTo.x + assistForward.z * assistTo.z);
    const pitch = Math.asin(assistTo.y) - Math.asin(assistForward.y);
    const score = Math.acos(Math.min(1, cos)) * (1 + distance / 200);
    if (score < bestScore) {
      bestScore = score;
      best = { yaw: -yaw, pitch };
    }
  }
  if (!best) return;
  const rate = 1 - Math.exp(-3.2 * dt);
  inputs.lookYaw += best.yaw * rate;
  inputs.lookPitch -= best.pitch * rate * 0.6;
}

const chase = new CameraRig();

// Repair crates: positions come from the shared arena, state from snapshots.
const crates = buildCrates();
scene.add(crates.group);
world.onShown = () => {
  crates.reset();
  skidMarks.clear();
};

// The closing danger zone: a ring the server moves, drawn from the snapshot.
const zoneRig = buildZone();
scene.add(zoneRig.object);

// Death explosions: a car costs the whole fight, so its end should be visible.
const explosions = new Explosions();
scene.add(explosions.object);
// Dust, tyre smoke, sparks and boost flame for every car (Phase 8).
const driveFx = new DriveFx();
scene.add(driveFx.object);
// Headlights and tail lights on every car; real beams from ours.
const carLights = new CarLights();
scene.add(carLights.object);
const drawingBuffer = new THREE.Vector2();
/** Cars further than this from the camera cast no shadow (metres). */
const SHADOW_CAR_DISTANCE = 60;
// Escalating smoke, fire and burning wrecks for damaged cars.
const damageFx = new DamageFx();
scene.add(damageFx.object);

// Muzzle flashes, impacts and rockets in flight: what makes a shot read.
const weaponFx = new WeaponFx();
scene.add(weaponFx.object);
/** A class's car-mounted weapons (from its first armed seat), or null. */
const seatsForRig = (cls: Parameters<typeof seatsFor>[0]) =>
  seatsFor(cls).find((seat) => seat.mounted)?.mounted ?? null;
/**
 * Title-screen showcase: the camera orbits our truck while the menu is up.
 * Drag anywhere off the buttons to turn it; after a moment idle it turns itself.
 */
const SHOWROOM_DISTANCE = 7.4;
/** A longer lens than the game's: the title is a film shot, not a driving view. */
const SHOWROOM_FOV = 50;
const showroom = {
  yaw: 0.7,
  dragging: false,
  lastX: 0,
  idle: 0,
  /** Seconds on the title, for the slow camera move. */
  clock: 0,
  key: new THREE.SpotLight(0xfff1dd, 0, 30, 0.55, 0.45, 1.2),
  rim: new THREE.PointLight(0x9fb8ff, 0, 14, 1.5),
};
scene.add(showroom.key, showroom.key.target, showroom.rim);
{
  const join = document.getElementById('join');
  join?.addEventListener('pointerdown', (e) => {
    // Not from controls: a captured pointer would swallow their click.
    if ((e.target as HTMLElement).closest('button, a, input, .drawer')) return;
    showroom.dragging = true;
    showroom.lastX = e.clientX;
    join.setPointerCapture(e.pointerId);
  });
  join?.addEventListener('pointermove', (e) => {
    if (!showroom.dragging) return;
    showroom.yaw -= (e.clientX - showroom.lastX) * 0.008;
    showroom.lastX = e.clientX;
    showroom.idle = 0;
  });
  const release = (): void => {
    showroom.dragging = false;
    showroom.idle = 0;
  };
  join?.addEventListener('pointerup', release);
  join?.addEventListener('pointercancel', release);
}

/** Projectile ids already seen, so a remote launch flashes exactly once. */
const seenProjectiles = new Set<number>();

// Audio. Created on the JOIN click — browsers refuse audio before a gesture.
const audio = new GameAudio();

// Music: lobby and match playlists (third-party; see ASSETS.md).
const music = new Music();
void music.load();

/**
 * One sound switch for SFX and music.
 *
 * Starts OFF because a browser will not play anything before a gesture, and the
 * menu carries a button to turn it on WITHOUT joining — otherwise the only way
 * to hear the lobby music is to leave the lobby, which is exactly the wrong way
 * round.
 */
let soundOn = false;
const setSound = (on: boolean): void => {
  soundOn = on;
  audio.init(); // a gesture is happening; safe to build/resume the graph
  if (on) music.start();
  audio.setEnabled(on);
  music.setEnabled(on);
  hud.setSoundOn(on);
};
hud.onSound(() => setSound(!soundOn));
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') setSound(!soundOn);
});

/** Scratch vector for reading the camera's view direction each frame. */
const camDir = new THREE.Vector3();
/** Scratch vector for projecting world points (damage numbers) to screen space. */
const projectV = new THREE.Vector3();

/**
 * First-match onboarding tips, shown once per browser tab. Kept in sessionStorage
 * so a reload does not repeat them but a new tab does.
 */
const tips = { controls: false, zone: false, outside: false };
try {
  tips.controls = sessionStorage.getItem('convoy.tip.controls') === '1';
  tips.zone = sessionStorage.getItem('convoy.tip.zone') === '1';
  tips.outside = sessionStorage.getItem('convoy.tip.outside') === '1';
} catch {
  // Private mode / storage disabled: tips simply show every time.
}
const rememberTip = (key: keyof typeof tips): void => {
  tips[key] = true;
  try {
    sessionStorage.setItem(`convoy.tip.${key}`, '1');
  } catch {
    // Ignore; the tip is not worth failing over.
  }
};

// ---------------------------------------------------------------- main loop

let accumulator = 0;
let previous = performance.now();
let lastInput: VehicleInput = { ...NEUTRAL_INPUT };

const obstacles: THREE.Object3D[] = [world.group];

/** Last known alive state per crew, so a death explosion fires on the edge. */
const wasAlive = new Map<number, boolean>();
/** Previous hull, so a hit plays a thud exactly once. */
let lastHull: number = COMBAT.maxHull;
/** Camera shake amplitude, decaying. Punch, not a permanent wobble. */
let shake = 0;
const addShake = (amount: number): void => {
  shake = Math.min(1.1, shake + amount);
};

/** Previous rear-wheel ground positions, used to lay skid marks. */
const lastSkid: {
  left: { x: number; z: number } | null;
  right: { x: number; z: number } | null;
} = { left: null, right: null };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  lighting.resize();
});

// Quality preset, cycled from the title screen and remembered per browser.
{
  const button = document.getElementById('join-quality');
  const label = (): void => {
    if (button) button.textContent = `QUALITY ${lighting.current.toUpperCase()}`;
  };
  label();
  button?.addEventListener('click', () => {
    const next = QUALITIES[(QUALITIES.indexOf(lighting.current) + 1) % QUALITIES.length];
    lighting.applyQuality(next);
    saveQuality(next);
    label();
  });
  // HIGH steps itself down if a match cannot hold the frame rate; say so.
  lighting.onAutoDowngrade = (quality) => {
    label();
    hud.showTip(`Quality lowered to ${quality.toUpperCase()} to keep the frame rate up`, 5);
  };
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const interval = now - previous;
  perf.begin(now);

  const realDt = Math.min((now - previous) / 1000, 0.25);
  previous = now;
  // A frame this long means the tab was backgrounded or the machine stalled.
  // Do NOT replay that time: simulating the missed seconds in a burst would
  // lurch every car forward. Resume instead.
  if (realDt >= 0.25) accumulator = 0;
  else accumulator += realDt;

  // Driving exists only during a live match, and not while our car is a wreck.
  // Outside those windows we predict neutral input: the server is doing the
  // same, so the two stay in agreement instead of the client rolling early and
  // eating a correction when the whistle blows.
  // Connected too: after leaving, the last match's state lingers until reset,
  // and "live" there kept the engine sound on and the keys driving the title car.
  const playing = net.connected && net.match.phase === 'live' && !net.localDead;
  // The in-game menu (Esc): the browser releases the mouse on Esc, so the menu
  // is "in a live match, had the mouse, and lost it". Before the first click
  // of a match the CLICK TO DRIVE prompt shows instead.
  const inMatch = net.connected && net.match.phase === 'live';
  // Gamepad: polled once a frame. The right stick aims only while driving.
  inputs.poll(realDt, playing && !hud.paused);
  if (!inMatch) setMenu(false);
  else if (inputs.locked && menuOpen && performance.now() - menuChangedAt > 300) setMenu(false); // re-locked: playing
  // Start opens and closes the menu.
  if (inputs.consumeMenuButton() && inMatch) {
    if (menuOpen) resumeFromMenu();
    else setMenu(true);
  }
  hud.setPauseVisible(inMatch && menuOpen);
  padNavigate(inputs.drainNav());
  if (inputs.touch && playing && !menuOpen) aimAssist(realDt);

  // Fixed-step PREDICTION. The server simulates at the same rate with the same
  // code, so replaying unacknowledged inputs reproduces its result.
  let steps = 0;
  while (accumulator >= TICK.dt && steps < 5) {
    // The match does not pause: with the menu open the car coasts.
    lastInput = playing && !hud.paused ? inputs.update(TICK.dt) : NEUTRAL_INPUT;
    net.stepLocal(lastInput);
    accumulator -= TICK.dt;
    steps++;
  }
  perf.mark('sim');
  if (accumulator > TICK.dt * 5) accumulator = 0;

  net.update(realDt);

  // An armed seat's view IS its aim, clamped to the weapon's arc; an unarmed
  // driver (the duel case) just looks around freely. The solo brawler drives
  // AND fires, so its view follows the gun — that is what makes a crosshair
  // meaningful while the car is moving.
  net.setAim(inputs.lookYaw, inputs.lookPitch, realDt);
  const viewYaw = net.canFire ? net.aimYaw : inputs.lookYaw;
  const viewPitch = net.canFire ? net.aimPitch : inputs.lookPitch;

  // ---- weapons ----------------------------------------------------------
  // Two triggers: left fires the primary, right the secondary (a car's heavy
  // weapon); a window gunner has only the held weapon on the left. Automatic
  // weapons fire while held, the rest on the press edge. Each slot is
  // rate-limited HERE to the same schedule the server keeps, so every tracer we
  // draw is a shot the server will accept — the server still has the last word.
  const triggers: Array<['primary' | 'secondary', boolean, boolean]> = [
    ['primary', inputs.wantsFire, inputs.consumeFirePress()],
    ['secondary', inputs.wantsFire2, inputs.consumeFire2Press()],
  ];
  if (playing && net.canFire) {
    for (const [trigger, held, pressedNow] of triggers) {
      const slot = net.slotFor(trigger);
      if (slot === null) continue;
      const weapon = WEAPONS[net.loadout[slot] ?? 'rifle'];
      if (!(weapon.automatic ? held : pressedNow)) continue;
      if (!net.canShoot(slot, now)) continue;

      // Draw our own shot NOW, from a local prediction, so the gun feels
      // attached to the trigger rather than to the network.
      const predicted = net.predictShot(slot);
      if (predicted) {
        const o = predicted.origin;
        const e = predicted.end;
        const length = Math.hypot(e.x - o.x, e.y - o.y, e.z - o.z) || 1;
        const dir = { x: (e.x - o.x) / length, y: (e.y - o.y) / length, z: (e.z - o.z) / length };
        const heavy = weapon.delivery === 'projectile';
        weaponFx.muzzle(o, dir, heavy);
        if (!heavy) {
          tracers.add(o, e);
          // Where a predicted round would land; the server's verdict follows.
          if (length < weapon.range - 0.5) weaponFx.impact(e, o, predicted.hitCrew !== null);
        }
        audio.shot(o.x, o.y, o.z, true, weapon.id);
        addShake(heavy ? 0.35 : 0.035);
      }
      net.fire(slot, now);
    }
  }
  if (inputs.consumeReload()) net.requestReload(net.slotFor('primary') ?? undefined);
  const switchTo = inputs.consumeSwitch();
  if (switchTo !== null) net.switchWeapon(switchTo);

  for (const shot of net.drainShots()) {
    const mine = shot.by === net.playerId;
    const shotWeapon = WEAPONS[shot.weapon];
    // A projectile's event is its IMPACT (sent when it lands): an explosion for
    // everyone, ours included, since we could not predict where it would land.
    if (shotWeapon.delivery === 'projectile') {
      explosions.add(shot.ex, shot.ey, shot.ez, 0.62);
      world.react({ kind: 'blast', x: shot.ex, z: shot.ez });
      audio.explosion(shot.ex, shot.ey, shot.ez, false);
      const me = net.renderState;
      const distance = Math.hypot(shot.ex - me.pos.x, shot.ez - me.pos.z);
      if (distance < 45) addShake(0.4 * (1 - distance / 45));
    } else if (!mine) {
      // Everyone else's gun is placed in the world, which is the whole point of
      // the positional mix. Ours already sounded at the trigger.
      audio.shot(shot.ox, shot.oy, shot.oz, false, shot.weapon);
    }
    if (mine) {
      // Ours: already drawn from prediction. The server's event is used only as
      // confirmation, so the hitmarker means a real hit rather than a hopeful one.
      if (shot.hitCrew !== null || shot.hitPlayer !== null) {
        hud.flashHitmarker();
        audio.hitConfirm(shotWeapon.delivery === 'projectile');
        // Damage number where the round landed, projected to screen space.
        projectV.set(shot.ex, shot.ey, shot.ez).project(camera);
        if (projectV.z < 1) {
          hud.damageNumber(
            (projectV.x * 0.5 + 0.5) * window.innerWidth,
            (-projectV.y * 0.5 + 0.5) * window.innerHeight,
            WEAPONS[shot.weapon].damage,
          );
        }
      }
    } else if (shotWeapon.delivery === 'hitscan') {
      const from = { x: shot.ox, y: shot.oy, z: shot.oz };
      const to = { x: shot.ex, y: shot.ey, z: shot.ez };
      tracers.add(from, to);
      const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) || 1;
      weaponFx.muzzle(from, { x: (to.x - from.x) / length, y: (to.y - from.y) / length, z: (to.z - from.z) / length });
      if (length < shotWeapon.range - 0.5) weaponFx.impact(to, from, shot.hitCrew !== null);
    }

    // Incoming: an arrow points at whoever hit our car, relative to the view.
    if (shot.hitCrew === net.crewId && shot.by !== net.playerId) {
      const me = net.renderState;
      const sourceYaw = Math.atan2(-(shot.ox - me.pos.x), -(shot.oz - me.pos.z));
      hud.flashDamage(wrapAngle(sourceYaw - (me.yaw + viewYaw)));
    }
  }
  tracers.update(realDt);

  // Rockets in flight. A projectile id we have not seen is a fresh launch: give
  // other players' rockets a launch flash and sound (our own fired at the trigger).
  for (const p of net.projectiles) {
    if (seenProjectiles.has(p.id)) continue;
    seenProjectiles.add(p.id);
    if (p.by !== net.playerId) {
      const len = Math.hypot(p.x - p.px, p.y - p.py, p.z - p.pz) || 1;
      weaponFx.muzzle({ x: p.px, y: p.py, z: p.pz }, { x: (p.x - p.px) / len, y: (p.y - p.py) / len, z: (p.z - p.pz) / len }, true);
      audio.shot(p.px, p.py, p.pz, false, p.weapon);
    }
  }
  if (seenProjectiles.size > 256) {
    const live = new Set(net.projectiles.map((p) => p.id));
    for (const id of seenProjectiles) if (!live.has(id)) seenProjectiles.delete(id);
  }
  weaponFx.updateRockets(net.projectiles, net.projectilesAt, now, realDt);
  weaponFx.update(realDt);
  for (const kill of net.drainKills()) {
    hud.addKill(kill.byCrew, kill.victimCrew);
    // A kill WE scored gets its own unmistakable confirmation.
    if (kill.byCrew !== null && kill.byCrew === net.crewId && kill.victimCrew !== net.crewId) {
      hud.confirmKill(`ELIMINATED · CAR ${kill.victimCrew}`);
      audio.hitmarker();
    }
  }

  // If the server assigned a different class (or corrected ours), swap the
  // local rig so the mesh matches the collider we are actually predicting with.
  if (net.local.spec.id !== localCarClass || lookKey(profile.look) !== localLookKey) {
    scene.remove(localCar.root);
    localCar.dispose();
    localCar = buildVehicle(net.local.spec, profile.look, partLibrary);
    scene.add(localCar.root);
    localCarClass = net.local.spec.id;
    localLookKey = lookKey(profile.look);
  }

  const local = net.renderState;

  // Once eliminated in a solo match, watch a survivor rather than our own wreck.
  // The survivor cycles every few seconds so a long endgame is not one camera.
  const spectating = net.localDead && net.match.phase === 'live';
  const survivors = spectating ? net.survivingCrews() : [];
  const spectateCrew =
    survivors.length > 0 ? survivors[Math.floor(now / 6000) % survivors.length] : null;
  const view = spectateCrew !== null ? (net.remotes.get(spectateCrew) ?? local) : local;

  // ---- skid marks (local car only) --------------------------------------
  const sliding = local.onGround && Math.abs(local.slipSpeed) > 3;
  const rearLeft = localToWorld(local, -local.spec.track / 2, local.spec.wheelbase / 2);
  const rearRight = localToWorld(local, local.spec.track / 2, local.spec.wheelbase / 2);
  if (sliding) {
    const y = local.groundY + 0.03;
    if (lastSkid.left) skidMarks.segment(lastSkid.left.x, lastSkid.left.z, rearLeft.x, rearLeft.z, y);
    if (lastSkid.right) {
      skidMarks.segment(lastSkid.right.x, lastSkid.right.z, rearRight.x, rearRight.z, y);
    }
    lastSkid.left = rearLeft;
    lastSkid.right = rearRight;
  } else {
    lastSkid.left = null;
    lastSkid.right = null;
  }

  localCar.update(local, lastInput, realDt, { hull: net.self.hull, maxHull: COMBAT.maxHull });
  // A destroyed car is off the field until the crew respawns: drawing it lying
  // there would suggest it is still shootable.
  localCar.root.visible = !net.localDead;
  if (!net.localDead && net.connected) damageFx.emit(net.crewId ?? -1, localCar.root, localCar.damageAnchors, local.vel, localCar.damage, realDt);
  if (net.crewId !== null) localCar.setOccupants(net.occupantsOf(net.crewId));
  // Our guns follow the crosshair, each only as far as it physically turns.
  localCar.setWeaponAims(net.mountedAims());

  // ---- remote cars ------------------------------------------------------
  for (const [id, state] of net.remotes) {
    let rig = remoteCars.get(id);
    const look = unpackLook(net.remoteLooks.get(id) ?? 0);
    const key = lookKey(look);
    if (!rig || rig.spec.id !== state.spec.id || remoteLookKeys.get(id) !== key) {
      // New crew, a class change, or new paint: rebuild with all of it.
      if (rig) {
        scene.remove(rig.root);
        rig.dispose();
      }
      rig = buildVehicle(state.spec, look, partLibrary);
      scene.add(rig.root);
      remoteCars.set(id, rig);
      remoteLookKeys.set(id, key);
    }
    rig.update(state, NEUTRAL_INPUT, realDt, {
      hull: net.hullOf(id),
      maxHull: COMBAT.maxHull,
    });
    rig.root.visible = !net.isDead(id);
    if (rig.root.visible) damageFx.emit(id, rig.root, rig.damageAnchors, state.vel, rig.damage, realDt);
    // A distant car's shadow is a few blurred texels: skip its shadow draws.
    rig.setShadowDetail(Math.hypot(state.pos.x - camera.position.x, state.pos.z - camera.position.z) < SHADOW_CAR_DISTANCE);
    rig.setOccupants(net.occupantsOf(id));
    // Their guns follow their driver's aim. The aim message carries the CAMERA
    // pitch (positive looks down), so it is negated into the gun's (positive up).
    const mounted = seatsForRig(state.spec.id);
    if (mounted) {
      const aimer = net.driverMember(id);
      rig.setWeaponAims(
        mounted.map((w) => ({
          yaw: clampToArc(w.yawArc, aimer?.aimYaw ?? 0),
          pitch: clamp(-(aimer?.aimPitch ?? 0), w.pitchArc[0], w.pitchArc[1]),
        })),
      );
    }
  }
  for (const [id, rig] of remoteCars) {
    if (!net.remotes.has(id)) {
      scene.remove(rig.root);
      rig.dispose();
      remoteCars.delete(id);
      remoteLookKeys.delete(id);
    }
  }

  perf.mark('world');

  // ---- car lights ---------------------------------------------------------
  carLights.begin(camera, renderer.getDrawingBufferSize(drawingBuffer).y);
  if (localCar.root.visible) {
    localCar.root.updateMatrixWorld();
    const braking = playing && (lastInput.handbrake || (lastInput.throttle < 0 && local.forwardSpeed > 1));
    carLights.add(localCar.root, localCar.lightAnchors, braking);
    carLights.beam(localCar.root, localCar.lightAnchors);
  } else {
    carLights.beam(null);
  }
  for (const [id, rig] of remoteCars) {
    if (!rig.root.visible || !net.remotes.has(id)) continue;
    rig.root.updateMatrixWorld();
    carLights.add(rig.root, rig.lightAnchors);
  }
  carLights.end();

  // ---- driving effects ------------------------------------------------------
  const localId = net.crewId ?? -1;
  const localBoosting = playing && lastInput.boost && local.boost > 0 && local.forwardSpeed > 5;
  if (localCar.root.visible) driveFx.emit(localId, localCar.root, local, localCar.lightAnchors.tail, localBoosting, realDt);
  for (const [id, rig] of remoteCars) {
    const state = net.remotes.get(id);
    if (!state || !rig.root.visible) continue;
    // A remote car's input is not known: over the normal top speed means boost.
    driveFx.emit(id, rig.root, state, rig.lightAnchors.tail, state.forwardSpeed > VEHICLE.maxSpeed * 1.03, realDt);
  }
  driveFx.update(realDt);

  // ---- death explosions -------------------------------------------------
  // Fire once on each alive→dead edge, for our car and every remote. The wreck
  // vanishes the same frame, so the burst lands where it died.
  const noteDeath = (crew: number, alive: boolean, x: number, y: number, z: number): void => {
    if (wasAlive.get(crew) === true && !alive) {
      explosions.add(x, y + 0.4, z, 1.15);
      damageFx.wreck(x, y, z);
      world.react({ kind: 'kill', x, z, label: net.names.get(crew) });
      audio.explosion(x, y + 0.4, z, crew === net.crewId);
      // Shake falls off with distance, so a kill across the map stays calm.
      const distance = Math.hypot(x - local.pos.x, z - local.pos.z);
      if (distance < 60) addShake(0.5 * (1 - distance / 60));
    }
    wasAlive.set(crew, alive);
  };
  if (net.crewId !== null) {
    noteDeath(net.crewId, !net.localDead, local.pos.x, local.pos.y, local.pos.z);
  }
  for (const [crew, state] of net.remotes) {
    noteDeath(crew, !net.isDead(crew), state.pos.x, state.pos.y, state.pos.z);
  }
  explosions.update(realDt);
  world.update(realDt, camera.position);
  damageFx.update(realDt, camera);
  perf.mark('fx');

  // Three cameras, three questions (DESIGN.md §7):
  //   unarmed driver   a view OF the car (chase) — a duel driver
  //   window gunner    a view FROM one window — a duel gunner
  //   armed driver     a view FORWARD of the car — the solo brawler, who must
  //                    see where the gun points while still driving
  const seat = net.seat ? seatById(net.vehicleClass, net.seat) : undefined;
  const inMenu = !net.connected;
  // Nothing predicts the car before we join, so settle it onto the ground here
  // (neutral input) — otherwise the showcase truck hovers at its spawn height.
  // Settled in fixed ticks until it lands, so it never hovers however low the
  // frame rate; then one tick a frame keeps it resting.
  if (inMenu) {
    for (let i = 0; i < 120 && !net.local.onGround; i++) stepVehicle(net.local, NEUTRAL_INPUT, TICK.dt);
    stepVehicle(net.local, NEUTRAL_INPUT, TICK.dt);
  }
  // A gentle key and rim on top of the arena's floodlights — at the old
  // pre-floodlight strength the key bloomed into a white blot beside the car.
  showroom.key.intensity = inMenu ? 14 : 0;
  showroom.rim.intensity = inMenu ? 6 : 0;
  if (inMenu) {
    // The title screen's HERO SHOT: a slow cinematic move round our own car
    // (wearing the garage's paint) — a long lens, low and heroic, pushing in
    // and out as it orbits. Drag to spin; it idles round on its own.
    showroom.idle += realDt;
    showroom.clock += realDt;
    if (!showroom.dragging && showroom.idle > 1.5) showroom.yaw += realDt * 0.12;
    const c = local.pos;
    const t = showroom.clock;
    const distance = SHOWROOM_DISTANCE + Math.sin(t * 0.13) * 1.3;
    camera.position.set(
      c.x + Math.sin(showroom.yaw) * distance,
      c.y + 0.55 + Math.sin(t * 0.09 + 1) * 0.4,
      c.z + Math.cos(showroom.yaw) * distance,
    );
    // The menu owns the left of the screen, so aim a little to the car's LEFT
    // and it sits right of centre. On a narrow (portrait) screen, centre it.
    const fx = c.x - camera.position.x;
    const fz = c.z - camera.position.z;
    const flen = Math.hypot(fx, fz) || 1;
    const shift = camera.aspect > 1.2 ? 2.1 : 0;
    camera.lookAt(c.x + (fz / flen) * shift, c.y + 0.45, c.z - (fx / flen) * shift);
    if (camera.fov !== SHOWROOM_FOV) {
      camera.fov = SHOWROOM_FOV;
      camera.updateProjectionMatrix();
    }
    showroom.key.position.set(c.x + Math.sin(showroom.yaw + 0.7) * 6, c.y + 6, c.z + Math.cos(showroom.yaw + 0.7) * 6);
    showroom.key.target.position.set(c.x, c.y, c.z);
    showroom.key.target.updateMatrixWorld();
    showroom.rim.position.set(c.x - Math.sin(showroom.yaw) * 5, c.y + 2.5, c.z - Math.cos(showroom.yaw) * 5);
  } else if (spectateCrew !== null) {
    // A dead player's camera is a chase view of a survivor, free-looking.
    chase.update(camera, view, inputs.lookYaw, inputs.lookPitch, realDt, obstacles);
  } else if (net.canFire && net.isDriver) {
    chase.updateSolo(camera, view, net.aimYaw, net.aimPitch, realDt, obstacles, {
      boosting: playing && lastInput.boost && local.boost > 0 && local.forwardSpeed > 5,
      offroad: driveFx.groundOf(net.crewId ?? -1) === 'dirt',
    });
  } else if (net.isDriver) {
    chase.update(camera, view, viewYaw, viewPitch, realDt, obstacles);
  } else if (seat) {
    chase.updateGunner(camera, view, seat, net.aimYaw, net.aimPitch, realDt, obstacles);
  }

  // Reticle-ray aiming, step one: ask the camera what is under the crosshair.
  // Done immediately after the camera is placed, so the answer belongs to the
  // frame the player is looking at. Every armed seat needs it, not just the
  // window gunner — the solo brawler's shot is corrected the same way.
  if (net.canFire && spectateCrew === null) {
    camera.getWorldDirection(camDir);
    net.setAimPoint(net.aimPointFrom(camera.position, camDir));
  }

  // Weapon reticles: where each mounted gun will ACTUALLY hit — the crosshair's
  // point when the gun can reach it, the edge of its traverse when it cannot.
  const mountedNow = net.mounted;
  const aimPoint = net.aimPoint;
  if (mountedNow && aimPoint && spectateCrew === null && !net.localDead && playing) {
    const aims = net.mountedAims();
    const me = net.local;
    hud.setReticles(
      mountedNow.map((weapon, i) => {
        const aim = aims[i];
        if (!aim) return { x: 0, y: 0, visible: false, outside: false, reloading: false };
        const pivot = vehiclePointWorld(me, weapon.mounts[0].pivot);
        const distance = Math.hypot(aimPoint.x - pivot.x, aimPoint.y - pivot.y, aimPoint.z - pivot.z);
        const yaw = me.yaw + aim.yaw;
        const cosPitch = Math.cos(aim.pitch);
        projectV
          .set(
            pivot.x - Math.sin(yaw) * cosPitch * distance,
            pivot.y + Math.sin(aim.pitch) * distance,
            pivot.z - Math.cos(yaw) * cosPitch * distance,
          )
          .project(camera);
        const wanted = relativeAim(me.yaw, pivot, aimPoint);
        return {
          x: (projectV.x * 0.5 + 0.5) * window.innerWidth,
          y: (-projectV.y * 0.5 + 0.5) * window.innerHeight,
          visible: projectV.z < 1,
          outside: Math.abs(wrapAngle(wanted.yaw - aim.yaw)) > 0.01 || Math.abs(wanted.pitch - aim.pitch) > 0.01,
          reloading: (net.self.allReloads[i] ?? 0) > 0,
        };
      }),
    );
  } else {
    hud.setReticles([]);
  }

  // Audio listener rides the camera; the engine note follows our own car.
  camera.getWorldDirection(camDir);
  audio.setListener(camera.position.x, camera.position.y, camera.position.z, camDir.x, camDir.y, camDir.z);
  audio.updateEngine(local.forwardSpeed, lastInput.throttle, realDt, {
    slip: local.slipSpeed,
    ground: driveFx.groundOf(net.crewId ?? -1),
    onGround: local.onGround,
    boosting: playing && lastInput.boost && local.boost > 0 && local.forwardSpeed > 5,
    // Only while actually driving: on the title, spectating or after leaving
    // a match, the engine and road layers fade out instead of holding the
    // last car's note (they did, after LEAVE MATCH).
    active: playing,
  });
  // Lobby playlist in menus; a quiet match bed while live, rising with the zone.
  music.setScene(net.match.phase === 'live' ? 'live' : 'lobby');
  // The match bed rises as the ring closes: 0 at the opening circle, 1 at the last.
  if (net.zone) {
    music.setIntensity((ZONE.startRadius - net.zone.radius) / (ZONE.startRadius - ZONE.endRadius));
  } else {
    music.setIntensity(0);
  }

  // Camera shake: applied after the camera is placed, decayed every frame.
  shake = Math.max(0, shake - realDt * 3.5);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.7;
    camera.position.y += (Math.random() - 0.5) * shake * 0.7;
    camera.rotation.z += (Math.random() - 0.5) * shake * 0.06;
  }

  // Keep the shadow frustum centred on whatever the camera is following.
  lighting.follow(view.pos.x, view.pos.z);
  if (net.match.phase === 'live') lighting.watchFrameRate(realDt);

  crates.update(net.crates);

  // ---- closing zone -----------------------------------------------------
  const zone = net.zone;
  if (zone) zoneRig.update(zone.x, zone.z, zone.radius, zone.shrinking);
  else zoneRig.update(0, 0, null, false);
  const outside = zone ? outsideZone(zone, local.pos.x, local.pos.z) : false;
  hud.setZone(zone, outside);
  audio.setZoneAlarm(outside && net.match.phase === 'live');

  // First-match onboarding: one tip at a time, once per tab.
  if (net.match.phase === 'live') {
    if (!tips.controls) {
      hud.showTip('WASD drive · mouse aim · left-click fire', 6);
      rememberTip('controls');
    } else if (!tips.zone && zone?.shrinking) {
      hud.showTip('The ring is closing — stay inside it', 6);
      rememberTip('zone');
    } else if (!tips.outside && outside) {
      hud.showTip('Outside the zone — get back in!', 3);
      rememberTip('outside');
    }
  }

  // Damage taken: a thud scaled by the size of the hit.
  const hull = net.self.hull;
  if (net.connected && hull < lastHull - 0.5) {
    const fraction = (lastHull - hull) / COMBAT.maxHull;
    audio.impact(fraction);
    addShake(0.18 + fraction * 1.2);
    // Being hit must be unmistakable: a red flash from the screen edges, scaled
    // by the damage, and the hull bar flashes.
    hud.flashHit(fraction);
  }
  lastHull = hull;

  hud.update(local, realDt);
  hud.setCombat({
    ...net.self,
    armed: net.canFire,
    components: local.components,
    showHealth: net.match.mode !== 'solo',
  });
  // Car-mounted weapons: one read-out per trigger, each on its own reload.
  hud.setMountedWeapons(
    mountedNow
      ? mountedNow.map((weapon, i) => {
          const def = WEAPONS[weapon.weapon];
          return {
            name: def.name,
            rounds: net.self.allRounds[i] ?? 0,
            magazine: def.magazine,
            reload: net.self.allReloads[i] ?? 0,
            reloadTotal: def.reloadSeconds,
          };
        })
      : null,
  );
  hud.setHurt(net.self.hull / COMBAT.maxHull);
  hud.setCrosshairVisible(net.connected && net.canFire && !net.localDead);
  // Interest management means the member list is a view, not a headcount — show
  // the match's roster for PLAYERS.
  hud.setNet(net.ping, net.jitter, net.match.roster, net.connected);
  // The loading screen holds until we are in, and gives up if the join never
  // lands, so a dead server returns you to the title instead of a stuck bar.
  // Waiting for a seat (server at its player limit, or a private room's match
  // still running) is not a stuck join.
  hud.setBusy(
    loadingSince && net.busy
      ? {
          online: net.busy.online,
          capacity: net.busy.capacity,
          retryIn: (net.busy.retryAt - now) / 1000,
          reason: net.busy.reason,
        }
      : null,
  );
  // Refused (no such room, room full…): back to the title, and say why.
  if (net.rejected) {
    roomUi.showRefusal(net.rejected);
    net.rejected = null;
    loadingSince = 0;
    hud.setLoading(null);
  }
  // The match's map. Prediction switches at once (it must agree with the
  // server); the scenery follows as soon as it has loaded, behind a card.
  if (net.connected && net.mapId !== world.mapId) {
    useMap(net.mapId);
    void world.show(net.mapId);
  }
  // The next map, named at the end of a match: download it during the results.
  if (net.nextMapId && net.nextMapId !== prefetched) {
    prefetched = net.nextMapId;
    void world.prefetch(net.nextMapId);
  }
  hud.setMapLoading(net.connected && world.loading ? MAPS[net.mapId].name : null);

  // A private room between matches: its lobby (and a free mouse to use it).
  const inRoomLobby = net.connected && net.room !== null && (net.match.phase === 'lobby' || net.match.phase === 'countdown');
  roomUi.setLobby(inRoomLobby && net.match.phase === 'lobby' ? net.room : null, net.callsign);
  if (roomUi.lobbyVisible && inputs.locked) document.exitPointerLock();
  if (net.busy) loadingSince = Math.max(loadingSince, now - 1000);
  if (loadingSince && net.connected) {
    loadingSince = 0;
    hud.setLoading(null);
  } else if (loadingSince && now - loadingSince > 15_000) {
    loadingSince = 0;
    hud.setLoading(null);
  }
  hud.setJoinVisible(!net.connected);
  // REJOIN while the server is still holding a car we left.
  if (!net.connected) {
    const held = net.heldSeconds;
    hud.setRejoin(held > 0 ? held : null);
  } else if (net.resumed) {
    net.resumed = false;
    hud.showTip('Back in the broadcast — your car held on without you', 5);
  }
  inputs.enabled = net.connected;
  // No CLICK TO DRIVE for a pad player: they never need the mouse.
  hud.setPromptVisible(!inputs.locked && playing && !menuOpen && !inputs.padActive && !inputs.touch);
  inputs.touch?.setVisible(playing && !menuOpen);
  hud.setMatch(net.match, net.crewId, net.localRespawnIn, net.localPlacement, spectateCrew);
  hud.setBoard(net.match.phase === 'results' ? net.board : [], net.crewId);

  // Cosmetic progression: count the match once, when its results screen appears.
  // A win is whatever the server already called a win for our crew.
  if (net.match.phase === 'results' && !resultsRecorded) {
    resultsRecorded = true;
    const me = net.crewId;
    if (me !== null && net.connected) {
      profile = applyMatch(profile, {
        won: net.match.winner !== null && net.match.winner === me,
        kills: net.match.scores[me] ?? 0,
      });
      garage?.render(profile);
    }
  } else if (net.match.phase !== 'results') {
    resultsRecorded = false;
  }

  perf.mark('hud');
  perf.gpuBegin();
  // Development only: a fixed camera for scenery screenshots (window.__shotCam).
  if (import.meta.env.DEV) {
    const shot = (window as unknown as { __shotCam?: { p: number[]; t: number[] } }).__shotCam;
    if (shot) {
      camera.position.set(shot.p[0], shot.p[1], shot.p[2]);
      camera.lookAt(shot.t[0], shot.t[1], shot.t[2]);
      lighting.follow(shot.t[0], shot.t[2]);
    }
  }
  lighting.render();
  perf.gpuEnd();
  perf.mark('render');
  perf.end(interval);
  // Dynamic resolution: keep the GPU inside the display's frame budget — only
  // while driving, after a warm-up. On the title, the first seconds compile
  // shaders, which read as overload: it stepped down three times, and every
  // step resizes the canvas, which flashed.
  drivingFor = playing ? drivingFor + realDt : 0;
  if (drivingFor > 5) lighting.adaptResolution(realDt, perf.gpuMs, perf.intervalMs, perf.budgetMs);
}

// Seed the local car at a spawn so the view is sensible before the server
// confirms which one we actually got.
{
  const spawn = SPAWNS[0];
  net.local.pos.x = spawn.x;
  net.local.pos.y = spawn.y;
  net.local.pos.z = spawn.z;
  net.local.yaw = spawn.yaw;
}

// Debug handle for the automated netcode test (scripts/nettest.mjs) and for
// poking at state from the browser console during development.
(window as unknown as { __convoy?: unknown }).__convoy = {
  net,
  world,
  scene,
  camera,
  renderer,
  inputs,
  tracers,
  explosions,
  audio,
  music,
  hud,
  lighting,
  damageFx,
  driveFx,
  groundAt,
  THREE,
  // Asset probes load built models through the same decoders the game uses.
  assets: { loader: gltfLoader, toLod },
  get localCar() {
    return localCar;
  },
};

requestAnimationFrame(frame);

// Cut from the stand-by card once the title has actually been drawn twice (the
// showroom car settled and lit), so the reveal never shows a half-built frame.
requestAnimationFrame(() => requestAnimationFrame(() => hud.setStandby(null)));

// ---- in-game menu actions ----
const relock = (): void => {
  try {
    void (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => undefined);
  } catch {
    // Too soon after leaving the lock: RESUME again in a moment.
  }
};
/** Close the menu and go back to driving (re-taking the mouse for a mouse player). */
function resumeFromMenu(): void {
  setMenu(false);
  if (!inputs.padActive && !inputs.touch) relock();
}
hud.onResume(resumeFromMenu);
hud.onLeave(() => {
  setMenu(false);
  hud.setPauseVisible(false);
  net.leave();
});
const inLiveMatch = (): boolean => net.connected && net.match.phase === 'live';
// Esc toggles the menu, locked or not.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !inLiveMatch()) return;
  if (performance.now() - menuChangedAt < 300) return; // the same press as the unlock below
  if (menuOpen) resumeFromMenu();
  else {
    setMenu(true);
    if (document.pointerLockElement) document.exitPointerLock();
  }
});
// The browser's own Esc releases the mouse (and may not deliver the key to the
// page): losing the lock mid-match opens the menu too.
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && inLiveMatch() && !menuOpen) setMenu(true);
});
