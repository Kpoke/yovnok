/**
 * Bolt-on body kits and door decals for the realistic car, placed against the
 * chassis's measured bounding box (car space: x across, y up, -z forward).
 * Looks only: the simulation never reads them.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DECALS, type RoofKind } from '../../shared/cosmetics';

const steel = new THREE.MeshStandardMaterial({ color: 0x2d3137, roughness: 0.45, metalness: 0.8 });
const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.15, metalness: 1 });
const lamp = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff4dd, emissiveIntensity: 2.4 });

/** A tube between two points. */
function tube(a: THREE.Vector3, b: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const length = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(radius, radius, length, 10);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export function buildBodyKit(kind: RoofKind, body: THREE.Box3): THREE.Group | null {
  const { min, max } = body;
  const w = max.x - min.x;
  const h = max.y - min.y;
  const group = new THREE.Group();
  group.name = `kit:${kind}`;
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    group.add(mesh);
  };

  if (kind === 'bullbar') {
    // A push bar across the nose: two uprights, two rails, a cross brace.
    const z = min.z - 0.12;
    const y0 = min.y + h * 0.12;
    const y1 = min.y + h * 0.48;
    const x = w * 0.36;
    add(
      mergeGeometries([
        tube(V(-x, y0, z), V(-x, y1, z), 0.045),
        tube(V(x, y0, z), V(x, y1, z), 0.045),
        tube(V(-x - 0.05, y1, z), V(x + 0.05, y1, z), 0.05),
        tube(V(-x - 0.05, (y0 + y1) / 2, z - 0.04), V(x + 0.05, (y0 + y1) / 2, z - 0.04), 0.04),
        tube(V(-x, y0, z), V(x, y1, z), 0.03),
        tube(V(x, y0, z), V(-x, y1, z), 0.03),
      ])!,
      steel,
    );
    return group;
  }
  if (kind === 'lights') {
    // A bar of lamps on the roof's front edge, ahead of the turret.
    const y = max.y + 0.06;
    const z = min.z + (max.z - min.z) * 0.36;
    add(box(w * 0.6, 0.12, 0.18, 0, y, z), steel);
    const lamps: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) lamps.push(box(w * 0.11, 0.08, 0.02, (i - 1.5) * w * 0.14, y, z - 0.1));
    add(mergeGeometries(lamps)!, lamp);
    return group;
  }
  if (kind === 'wing') {
    // A rear wing on two struts over the boot lid.
    const z = max.z - 0.32;
    const deck = min.y + h * 0.62;
    const top = deck + 0.38;
    add(mergeGeometries([box(0.06, top - deck, 0.12, -w * 0.3, (deck + top) / 2, z), box(0.06, top - deck, 0.12, w * 0.3, (deck + top) / 2, z)])!, steel);
    const blade = new THREE.BoxGeometry(w * 0.92, 0.05, 0.42);
    blade.rotateX(-0.12);
    blade.translate(0, top, z + 0.05);
    add(mergeGeometries([blade, box(0.04, 0.22, 0.5, -w * 0.46, top + 0.06, z + 0.05), box(0.04, 0.22, 0.5, w * 0.46, top + 0.06, z + 0.05)])!, steel);
    return group;
  }
  if (kind === 'armour') {
    // Riveted plates along both flanks, between the wheel arches.
    const plates: THREE.BufferGeometry[] = [];
    const rivets: THREE.BufferGeometry[] = [];
    const length = (max.z - min.z) * 0.36;
    for (const side of [-1, 1]) {
      const x = side * (w / 2 + 0.03);
      const y = min.y + h * 0.28;
      plates.push(box(0.05, h * 0.26, length, x, y, 0));
      for (let i = -2; i <= 2; i++) rivets.push(box(0.03, 0.05, 0.05, x + side * 0.03, y + h * 0.09, i * length * 0.22));
    }
    add(mergeGeometries(plates)!, steel);
    add(mergeGeometries(rivets)!, chrome);
    return group;
  }
  if (kind === 'exhaust') {
    // Side pipes along the sills, ending just ahead of the rear wheels.
    const pipes: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const x = side * (w / 2 + 0.06);
      const y = min.y + h * 0.1;
      pipes.push(tube(V(x, y, min.z * 0.35), V(x, y, max.z * 0.35), 0.07));
      pipes.push(tube(V(x, y, max.z * 0.35), V(x + side * 0.05, y + 0.02, max.z * 0.42), 0.075));
    }
    add(mergeGeometries(pipes)!, chrome);
    return group;
  }
  return null;
}

/** The door decal's artwork, drawn once per (decal, number, colour). */
const decalTextures = new Map<string, THREE.CanvasTexture>();
function decalTexture(decal: string, number: number, accent: number): THREE.CanvasTexture {
  const key = `${decal}:${number}:${accent}`;
  const cached = decalTextures.get(key);
  if (cached) return cached;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const ink = `#${accent.toString(16).padStart(6, '0')}`;
  const c = size / 2;
  ctx.lineJoin = 'round';
  if (decal === 'roundel') {
    ctx.fillStyle = '#f4f4f0';
    ctx.beginPath();
    ctx.arc(c, c, c - 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = ink;
    ctx.stroke();
    if (number > 0) {
      ctx.fillStyle = '#111';
      ctx.font = `900 ${number > 9 ? 128 : 150}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(number), c, c + 8);
    }
  } else if (decal === 'flames') {
    ctx.fillStyle = ink;
    for (let i = 0; i < 5; i++) {
      const y = 50 + i * 38;
      ctx.beginPath();
      ctx.moveTo(10, y);
      ctx.bezierCurveTo(90, y - 40, 150, y + 25, 246, y - 12 + (i % 2) * 20);
      ctx.bezierCurveTo(160, y + 30, 90, y + 10, 10, y + 26);
      ctx.fill();
    }
  } else if (decal === 'bolt') {
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (const [x, y] of [
      [150, 10],
      [70, 140],
      [125, 140],
      [95, 246],
      [190, 100],
      [135, 100],
    ])
      ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  } else if (decal === 'skull') {
    ctx.fillStyle = '#f2f0e8';
    ctx.beginPath();
    ctx.arc(c, c - 20, 84, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(c - 48, c + 40, 96, 60);
    ctx.fillStyle = '#111';
    for (const x of [c - 34, c + 34]) {
      ctx.beginPath();
      ctx.arc(x, c - 18, 24, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = -1; i <= 1; i++) ctx.fillRect(c + i * 28 - 6, c + 52, 12, 44);
  } else if (decal === 'star') {
    ctx.fillStyle = ink;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 118 : 48;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  decalTextures.set(key, texture);
  return texture;
}

/** The decal on both doors (and the race number on the roof, for the TV camera). */
export function buildDecals(index: number, number: number, accent: number, body: THREE.Box3): THREE.Group | null {
  const decal = DECALS[index]?.id ?? 'none';
  if (decal === 'none') return null;
  const group = new THREE.Group();
  group.name = 'decals';
  const material = new THREE.MeshStandardMaterial({
    map: decalTexture(decal, number, accent),
    transparent: true,
    alphaTest: 0.05,
    roughness: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  const { min, max } = body;
  const h = max.y - min.y;
  const size = Math.min(h * 0.42, 0.62);
  for (const side of [-1, 1]) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
    plane.position.set(side * (max.x + 0.015), min.y + h * 0.42, (min.z + max.z) / 2 + 0.1);
    plane.rotation.y = side * (Math.PI / 2);
    group.add(plane);
  }
  return group;
}
