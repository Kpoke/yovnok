/**
 * A gradient sky dome (M9 art fidelity).
 *
 * A flat background colour reads as a painted wall — there is no horizon, and
 * nothing tells you which way is up but the geometry. A large inward-facing
 * sphere with a vertical gradient fixes that for one draw call, and its horizon
 * colour is the FOG colour so the dome and the fogged terrain meet invisibly.
 *
 * Depth is off and it renders first, so it is pure backdrop: no fogging (fog
 * would wash the gradient out), no shadow, no interaction with anything.
 */

import * as THREE from 'three';
import { LIGHTING_PRESETS, type LightingPreset } from '../shared/config';

export function buildSky(): THREE.Mesh {
  // Radius must fit inside the camera's far plane from ANY point in the arena,
  // or the dome's far side is clipped and you see a polygon of flat background
  // around it. Arena half-extent 400 (M11) plus a chase camera ~10 behind, so the
  // eye is at most ~420 from the centre; 900 + 420 = 1320, under the 1400 far
  // plane — keep the dome and the far plane in step if the map grows.
  const geometry = new THREE.SphereGeometry(900, 32, 16);

  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColour: { value: new THREE.Color() },
      uSunSize: { value: 0 },
      uSunGlow: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uSunDir;
      uniform vec3 uSunColour;
      uniform float uSunSize;
      uniform float uSunGlow;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld);
        // Height of this fragment on the dome, 0 at the horizon, 1 overhead.
        float h = dir.y;
        // A gentle curve: more sky than horizon, so the ground stays readable.
        float t = clamp(pow(max(h, 0.0), 0.55), 0.0, 1.0);
        vec3 colour = mix(uBottom, uTop, t);
        // The sun: a soft disc and a wide glow around it.
        float facing = max(dot(dir, uSunDir), 0.0);
        float disc = smoothstep(1.0 - uSunSize * 0.002, 1.0 - uSunSize * 0.0015, facing);
        float glow = pow(facing, 12.0) * uSunGlow * 0.35 + pow(facing, 160.0) * uSunGlow;
        colour += uSunColour * (disc * 3.0 + glow);
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  setSky(mesh, LIGHTING_PRESETS.floodlitNight);
  return mesh;
}

/** Repaint a dome for a map's time of day. */
export function setSky(mesh: THREE.Mesh, preset: LightingPreset): void {
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  (u.uTop.value as THREE.Color).setHex(preset.sky.skyTop);
  (u.uBottom.value as THREE.Color).setHex(preset.sky.skyBottom);
  const [x, y, z] = preset.keyOffset;
  (u.uSunDir.value as THREE.Vector3).set(x, y, z).normalize();
  (u.uSunColour.value as THREE.Color).setHex(preset.sun?.colour ?? 0);
  u.uSunSize.value = preset.sun?.size ?? 0;
  u.uSunGlow.value = preset.sun?.glow ?? 0;
}
