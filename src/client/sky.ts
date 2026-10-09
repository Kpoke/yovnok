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
import { SKY } from '../shared/config';

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
      uTop: { value: new THREE.Color(SKY.skyTop) },
      uBottom: { value: new THREE.Color(SKY.skyBottom) },
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
      varying vec3 vWorld;
      void main() {
        // Height of this fragment on the dome, 0 at the horizon, 1 overhead.
        float h = normalize(vWorld).y;
        // A gentle curve: more sky than horizon, so the ground stays readable.
        float t = clamp(pow(max(h, 0.0), 0.55), 0.0, 1.0);
        gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}
