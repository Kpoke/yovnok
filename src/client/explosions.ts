/**
 * Vehicle death: the explosion when a car is destroyed (DESIGN.md §8).
 *
 * A destroyed car used to simply vanish, which reads as a bug rather than a
 * kill. This is the feedback for it: a flash, a burst of fire, a rising smoke
 * column and a ground shock ring, at the wreck's last position.
 *
 * INSTANCED, not sprites. The first version used one `THREE.Sprite` per particle
 * with its own material — needed because a SpriteMaterial carries opacity — and
 * that measured **+47 draw calls per explosion**, which is a lot to spend on a
 * cosmetic effect when a fight can wipe several cars at once. Fire and smoke are
 * now two instanced meshes with a small billboard shader, so the whole particle
 * field is two draw calls regardless of how many particles are alive. Only the
 * shock ring and the light remain separate.
 *
 * Client-side and purely cosmetic: the server decides the death, this shows it.
 */

import * as THREE from 'three';

const FIRE_CAPACITY = 64;
const SMOKE_CAPACITY = 40;

export type Particle = {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  drag: number;
  gravity: number;
  /** Colour at birth and at death, lerped over the life. */
  r0: number; g0: number; b0: number;
  r1: number; g1: number; b1: number;
  /** Opacity at birth and per-second fade. */
  opacity: number;
  fade: number;
};

const newParticle = (): Particle => ({
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
  life: 0, maxLife: 1, size0: 1, size1: 1, drag: 0, gravity: 0,
  r0: 1, g0: 1, b0: 1, r1: 0, g1: 0, b1: 0,
  opacity: 0, fade: 1,
});

/** A soft white blob, shared by every particle. */
export function softTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * A fixed pool of camera-facing quads drawn in one instanced call.
 *
 * The quad is expanded in VIEW space around each instance's centre, so it always
 * faces the camera without the CPU touching a matrix per particle per frame.
 */
export class ParticlePool {
  readonly mesh: THREE.Mesh;

  private geometry: THREE.InstancedBufferGeometry;
  private centres: Float32Array;
  private colours: Float32Array;
  private sizes: Float32Array;
  private opacities: Float32Array;
  private aCentre: THREE.InstancedBufferAttribute;
  private aColour: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private aOpacity: THREE.InstancedBufferAttribute;
  private particles: Particle[];
  private cursor = 0;

  constructor(capacity: number, texture: THREE.Texture, blending: THREE.Blending, order: number) {
    this.centres = new Float32Array(capacity * 3);
    this.colours = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.opacities = new Float32Array(capacity);
    this.particles = Array.from({ length: capacity }, newParticle);

    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    this.geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.aCentre = new THREE.InstancedBufferAttribute(this.centres, 3);
    this.aColour = new THREE.InstancedBufferAttribute(this.colours, 3);
    this.aSize = new THREE.InstancedBufferAttribute(this.sizes, 1);
    this.aOpacity = new THREE.InstancedBufferAttribute(this.opacities, 1);
    for (const [name, attr] of [
      ['aCentre', this.aCentre],
      ['aColour', this.aColour],
      ['aSize', this.aSize],
      ['aOpacity', this.aOpacity],
    ] as const) {
      attr.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, attr);
    }
    this.geometry.instanceCount = capacity;

    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: `
        attribute vec3 aCentre;
        attribute vec3 aColour;
        attribute float aSize;
        attribute float aOpacity;
        varying vec3 vColour;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          vColour = aColour;
          vAlpha = aOpacity;
          vUv = uv;
          // Billboard: expand the quad in view space around the instance centre.
          vec4 mv = modelViewMatrix * vec4(aCentre, 1.0);
          mv.xy += position.xy * aSize;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec3 vColour;
        varying vec2 vUv;
        varying float vAlpha;
        void main() {
          float a = texture2D(uMap, vUv).a * vAlpha;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(vColour, a);
          // Colours are LINEAR. Without these a ShaderMaterial writes them raw:
          // correct only on HIGH (whose OutputPass converts), far too dark when
          // drawing straight to the canvas (LOW/MEDIUM) — dust vanished there.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      blending,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = blending === THREE.AdditiveBlending ? 'explosion-fire' : 'explosion-smoke';
  }

  /** Spawn into a free slot, or reuse the oldest if the pool is saturated. */
  spawn(init: (p: Particle) => void): void {
    const capacity = this.particles.length;
    for (let i = 0; i < capacity; i++) {
      const p = this.particles[(this.cursor + i) % capacity];
      if (p.life > 0) continue;
      this.cursor = (this.cursor + i + 1) % capacity;
      init(p);
      return;
    }
    // Saturated: take the next slot regardless, the newest burst reads as it.
    const p = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % capacity;
    init(p);
  }

  update(dt: number): void {
    const { particles, centres, colours, sizes, opacities } = this;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const o = i * 3;
      if (p.life <= 0) {
        opacities[i] = 0;
        sizes[i] = 0;
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) {
        opacities[i] = 0;
        sizes[i] = 0;
        continue;
      }

      const damping = Math.exp(-p.drag * dt);
      p.vx *= damping;
      p.vz *= damping;
      p.vy = p.vy * damping - p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      p.opacity = Math.max(0, p.opacity - p.fade * dt);
      const k = 1 - p.life / p.maxLife; // 0 at birth, 1 at death

      centres[o] = p.x;
      centres[o + 1] = p.y;
      centres[o + 2] = p.z;
      colours[o] = p.r0 + (p.r1 - p.r0) * k;
      colours[o + 1] = p.g0 + (p.g1 - p.g0) * k;
      colours[o + 2] = p.b0 + (p.b1 - p.b0) * k;
      sizes[i] = p.size0 + (p.size1 - p.size0) * k;
      opacities[i] = p.opacity;
    }

    this.aCentre.needsUpdate = true;
    this.aColour.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aOpacity.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class Explosions {
  readonly object: THREE.Group;

  private fire: ParticlePool;
  private smoke: ParticlePool;
  private flashLight: THREE.PointLight;
  private lightLife = 0;
  private ring: THREE.Mesh;
  private ringLife = 0;

  constructor() {
    this.object = new THREE.Group();
    this.object.name = 'explosions';

    const texture = softTexture();
    this.fire = new ParticlePool(FIRE_CAPACITY, texture, THREE.AdditiveBlending, 3);
    this.smoke = new ParticlePool(SMOKE_CAPACITY, texture, THREE.NormalBlending, 2);
    this.object.add(this.fire.mesh);
    this.object.add(this.smoke.mesh);

    this.flashLight = new THREE.PointLight(0xffa855, 0, 46, 2);
    this.object.add(this.flashLight);

    const ringGeometry = new THREE.RingGeometry(0.86, 1, 48);
    ringGeometry.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffca7a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.ring.name = 'explosion-ring';
    this.ring.renderOrder = 3;
    this.ring.visible = false;
    this.object.add(this.ring);
  }

  /** Detonate at a world point. `scale` lets a bigger vehicle hit harder. */
  add(x: number, y: number, z: number, scale = 1): void {
    const spawnFire = (
      ox: number, oy: number, oz: number,
      vx: number, vy: number, vz: number,
      life: number, size0: number, size1: number, gravity: number, fade: number,
      r0: number, g0: number, b0: number, r1: number, g1: number, b1: number,
    ): void => {
      this.fire.spawn((p) => {
        p.x = ox; p.y = oy; p.z = oz;
        p.vx = vx; p.vy = vy; p.vz = vz;
        p.life = life; p.maxLife = life;
        p.size0 = size0; p.size1 = size1;
        p.drag = 2.2; p.gravity = gravity;
        p.r0 = r0; p.g0 = g0; p.b0 = b0;
        p.r1 = r1; p.g1 = g1; p.b1 = b1;
        p.opacity = 1; p.fade = fade;
      });
    };

    // Flash: a few large, near-white, very short-lived puffs.
    for (let i = 0; i < 3; i++) {
      spawnFire(
        x + rand(-0.4, 0.4) * scale,
        y + rand(0, 0.9) * scale,
        z + rand(-0.4, 0.4) * scale,
        rand(-1, 1), rand(-1, 1), rand(-1, 1),
        rand(0.12, 0.2),
        rand(3, 5) * scale, rand(7, 10) * scale,
        0, 6, // no gravity, fade fast
        1, 0.95, 0.77,
        1, 0.79, 0.48,
      );
    }

    // Body: an outward burst of fire that arcs down and cools to embers.
    for (let i = 0; i < 26; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(3, 13) * scale;
      spawnFire(
        x + rand(-0.4, 0.4) * scale,
        y + rand(0, 0.8) * scale,
        z + rand(-0.4, 0.4) * scale,
        Math.cos(angle) * speed, rand(2, 11) * scale, Math.sin(angle) * speed,
        rand(0.35, 0.95),
        rand(0.7, 1.8) * scale, rand(0.1, 0.4) * scale,
        14, 1.6,
        1, 0.82, 0.48,
        0.29, 0.1, 0.02,
      );
    }

    // Smoke: slower, rises, and thickens as it fades.
    for (let i = 0; i < 16; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(0.6, 2.4) * scale;
      this.smoke.spawn((p) => {
        p.x = x + rand(-0.5, 0.5) * scale;
        p.y = y + rand(0, 0.8) * scale;
        p.z = z + rand(-0.5, 0.5) * scale;
        p.vx = Math.cos(angle) * speed * 0.6;
        p.vy = rand(1.4, 3.2) * scale;
        p.vz = Math.sin(angle) * speed * 0.6;
        p.life = rand(1.4, 2.6);
        p.maxLife = p.life;
        p.size0 = rand(1.4, 2.6) * scale;
        p.size1 = rand(3.5, 6) * scale;
        p.drag = 1.6;
        p.gravity = -1.1; // negative gravity = rises
        p.r0 = 0.16; p.g0 = 0.16; p.b0 = 0.17;
        p.r1 = 0.06; p.g1 = 0.06; p.b1 = 0.07;
        p.opacity = 0.55; p.fade = 0.5;
      });
    }

    this.flashLight.position.set(x, y + 1.2, z);
    this.lifeSpan(0.28);
    this.flashLight.intensity = 26 * scale;

    this.ring.position.set(x, 0.08, z);
    this.ring.scale.setScalar(1);
    this.ring.visible = true;
    this.ringLife = 0.45;
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85;
  }

  private lifeSpan(seconds: number): void {
    this.lightLife = seconds;
  }

  update(dt: number): void {
    this.fire.update(dt);
    this.smoke.update(dt);

    if (this.lightLife > 0) {
      this.lightLife -= dt;
      this.flashLight.intensity = Math.max(0, this.lightLife / 0.28) * 26;
      if (this.lightLife <= 0) this.flashLight.intensity = 0;
    }

    if (this.ringLife > 0) {
      this.ringLife -= dt;
      const k = 1 - Math.max(0, this.ringLife) / 0.45;
      this.ring.scale.setScalar(1 + k * 9);
      (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k);
      if (this.ringLife <= 0) this.ring.visible = false;
    }
  }

  dispose(): void {
    this.fire.dispose();
    this.smoke.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}
