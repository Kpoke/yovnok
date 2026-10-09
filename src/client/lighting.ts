/**
 * Night under floodlights: how the arena is lit, and the frame's post-process.
 *
 * A single "sun" and a sky-gradient environment lit realistic (PBR) materials
 * badly: anything facing away from the sun went black, and the environment the
 * metals reflected was a flat gradient. This replaces it with what a floodlit
 * stadium actually has:
 *
 *   - image-based light from a real night HDRI (Poly Haven "Satara Night", CC0)
 *     — natural fill and reflections; the visible sky stays our own dome;
 *   - a KEY light from one bank of floodlights, casting the shadows;
 *   - FILL lights from the other corner masts, so no face goes black;
 *   - bloom on what glows (LED boards, lamps, muzzle flashes, explosions).
 *
 * Quality presets trade those costs. Measured (2026-10-07): the bloom chain —
 * scene into a half-float MSAA target, sanitise, bloom mips, output — cost the
 * frame rate ~4× at retina resolution, 120 fps → ~35. So LOW and MEDIUM draw
 * straight to the canvas (native MSAA, no post) and get their glow from
 * additive halos on the lamps instead; only HIGH runs real bloom, and it steps
 * itself down to MEDIUM if a match cannot hold the frame rate.
 */

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { LIGHTING } from '../shared/config';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];

const QUALITY: Record<Quality, { pixelRatio: number; shadow: number; bloom: boolean; msaa: number }> = {
  low: { pixelRatio: 1, shadow: 1024, bloom: false, msaa: 0 },
  medium: { pixelRatio: 1.5, shadow: 2048, bloom: false, msaa: 0 },
  // At 2× pixel ratio the image is already supersampled: MSAA on top of a
  // half-float target is the most expensive thing in the chain and buys little.
  // 1.5×, not 2×: measured on a 136 Hz retina MacBook at 2× (3024×1668) the GPU
  // took 22 ms a frame against a 7.4 ms budget — fill-bound. 1.5× is 56% of the
  // pixels and still sharp; the bloom runs at half that again.
  high: { pixelRatio: 1.5, shadow: 2048, bloom: true, msaa: 0 },
};

/**
 * HIGH steps down to MEDIUM when a match runs, for `AUTO_WINDOW` s, below this
 * fraction of the DISPLAY's refresh rate (~102 fps at 136 Hz, 45 at 60 Hz).
 * A fixed "under 50 fps" never fired on a 120–144 Hz screen running at 80 with
 * 1% lows of 30, which is exactly the stutter it exists to catch.
 */
const AUTO_REFRESH_FRACTION = 0.75;
const AUTO_WINDOW = 4;

/**
 * Bloom at HALF the render resolution. It is a wide blur: half resolution is
 * indistinguishable and a quarter of the fill. The composer calls `setSize` with
 * the full size on every resize, so halve it here rather than once at creation.
 */
class HalfResBloomPass extends UnrealBloomPass {
  override setSize(width: number, height: number): void {
    super.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }
}

const STORAGE_KEY = 'convoy.quality';

/** The saved preset, or a guess from the device: phones and low-DPR laptops start lower. */
export function loadQuality(): Quality {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as Quality | null;
    if (saved && QUALITIES.includes(saved)) return saved;
  } catch {
    // Storage disabled: fall through to the guess.
  }
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return mobile ? 'low' : 'medium';
}

export function saveQuality(quality: Quality): void {
  try {
    localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // Not worth failing over.
  }
}

/**
 * Clamp the HDR frame before bloom. A single pixel can overflow the half-float
 * target (a razor-sharp specular highlight on glass or chrome → Inf, or NaN
 * from a degenerate normal); bloom then smears that one pixel into a glowing
 * disc metres across. Nothing real in the scene is brighter than this ceiling.
 */
const SanitiseShader = {
  uniforms: { tDiffuse: { value: null }, ceiling: { value: 24 } },
  vertexShader: `varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float ceiling; varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c.rgb)) || any(isinf(c.rgb))) c.rgb = vec3(0.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, ceiling), c.a);
    }`,
};

export class Lighting {
  /** The floodlight key: the one light that casts shadows; it follows the view. */
  readonly key: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  /** Smoothed frame time, and the shortest frame seen (≈ the display's refresh). */
  private frameEma = 1 / 60;
  private refresh = 1 / 60;
  /** Seconds the match has run too slow on HIGH. */
  private slow = 0;
  /** Called when quality steps itself down, so the UI can say so. */
  onAutoDowngrade: ((quality: Quality) => void) | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private quality: Quality;
  /**
   * Dynamic resolution: a multiplier on the preset's pixel ratio, lowered when
   * the GPU cannot finish a frame inside the display's budget and raised again
   * when it can. Measured on a 131 Hz MacBook at HIGH: ~8.7 ms GPU against a
   * 7.6 ms budget — 4% of frames missed and showed as hitches.
   */
  private resolutionScale = 1;
  private overFor = 0;
  private underFor = 0;
  private resizeCooldown = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    quality: Quality,
  ) {
    this.quality = quality;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = LIGHTING.exposure;

    scene.add(new THREE.HemisphereLight(LIGHTING.hemiSky, LIGHTING.hemiGround, LIGHTING.hemiIntensity));

    // Key: one bank of floodlights, high and off to one corner.
    this.key = new THREE.DirectionalLight(LIGHTING.keyColour, LIGHTING.keyIntensity);
    this.key.castShadow = true;
    const extent = 110;
    Object.assign(this.key.shadow.camera, { left: -extent, right: extent, top: extent, bottom: -extent, near: 10, far: 400 });
    this.key.shadow.bias = -0.0008;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);

    // Fill: the opposite bank, so the faces the key misses are not black. One
    // light, not three: every light is a full BRDF evaluation in every pixel of
    // every lit material, and the HDRI already fills from all round.
    this.fill = new THREE.DirectionalLight(LIGHTING.fillColour, LIGHTING.fillIntensity);
    this.fill.position.set(120, 110, 120);
    scene.add(this.fill);

    this.applyQuality(quality);
  }

  /** Load the night HDRI and use it as the scene's environment light. */
  async loadEnvironment(url: string): Promise<void> {
    try {
      const hdr = await new HDRLoader().loadAsync(url);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      this.scene.environmentIntensity = LIGHTING.environmentIntensity;
      hdr.dispose();
      pmrem.dispose();
    } catch (error) {
      console.warn('[lighting] HDRI failed to load; keeping the sky environment', error);
    }
  }

  get current(): Quality {
    return this.quality;
  }

  applyQuality(quality: Quality): void {
    this.quality = quality;
    this.resolutionScale = 1;
    const q = QUALITY[quality];
    this.renderer.setPixelRatio(this.pixelRatioFor(q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.key.shadow.mapSize.x !== q.shadow) {
      this.key.shadow.mapSize.set(q.shadow, q.shadow);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }

    this.composer?.dispose();
    this.composer = null;
    this.bloom = null;
    if (q.bloom) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      // A float target keeps the HDR range for bloom; samples keep MSAA, which
      // the renderer's own antialias flag no longer provides once a composer
      // draws into an offscreen target.
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.msaa });
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new ShaderPass(SanitiseShader));
      this.bloom = new HalfResBloomPass(
        new THREE.Vector2(size.x / 2, size.y / 2),
        LIGHTING.bloomStrength,
        LIGHTING.bloomRadius,
        LIGHTING.bloomThreshold,
      );
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
  }

  /** The preset's pixel ratio, capped by the display and scaled; never below 1. */
  private pixelRatioFor(preset: number): number {
    const max = Math.min(window.devicePixelRatio, preset);
    return Math.max(Math.min(1, max), max * this.resolutionScale);
  }

  /**
   * Once a frame: hold the GPU inside the display's frame budget by scaling the
   * render resolution. Uses the GPU timer where the browser has one, else the
   * frame interval. Steps down quickly, back up slowly, never below 1×.
   */
  adaptResolution(dt: number, gpuMs: number | null, intervalMs: number, budgetMs: number): void {
    const max = Math.min(window.devicePixelRatio, QUALITY[this.quality].pixelRatio);
    if (max <= 1) return; // nothing to scale
    this.resizeCooldown -= dt;
    const load = gpuMs ?? intervalMs;
    const heavy = gpuMs !== null ? load > budgetMs * 0.9 : load > budgetMs * 1.15;
    const light = gpuMs !== null ? load < budgetMs * 0.65 : load < budgetMs * 1.02;
    this.overFor = heavy ? this.overFor + dt : 0;
    this.underFor = light ? this.underFor + dt : 0;
    let next = this.resolutionScale;
    if (this.overFor > 0.5) next -= 0.08;
    else if (this.underFor > 4) next += 0.05;
    next = Math.min(1, Math.max(1 / max, next));
    if (Math.abs(next - this.resolutionScale) < 0.01 || this.resizeCooldown > 0) return;
    this.resolutionScale = next;
    this.overFor = 0;
    this.underFor = 0;
    this.resizeCooldown = 1;
    this.renderer.setPixelRatio(this.pixelRatioFor(QUALITY[this.quality].pixelRatio));
    this.resize();
  }

  /** Keep the shadow camera on whatever the view is following. */
  follow(x: number, z: number): void {
    this.key.position.set(x + LIGHTING.keyOffset[0], LIGHTING.keyOffset[1], z + LIGHTING.keyOffset[2]);
    this.key.target.position.set(x, 0, z);
    this.key.target.updateMatrixWorld();
  }

  resize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.composer) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.composer.setSize(window.innerWidth, window.innerHeight);
      this.bloom?.resolution.set(size.x / 2, size.y / 2);
    }
  }

  /**
   * Called once a frame during a live match: if HIGH cannot hold the frame rate,
   * fall back to MEDIUM (once — a manual choice of HIGH afterwards is respected
   * until the next page load).
   */
  watchFrameRate(dt: number): void {
    if (this.quality !== 'high' || !this.onAutoDowngrade || dt <= 0) return;
    this.refresh = Math.min(this.refresh * 1.0005, Math.max(dt, 1 / 360));
    this.frameEma += (dt - this.frameEma) * 0.05;
    const wanted = (1 / this.refresh) * AUTO_REFRESH_FRACTION;
    this.slow = 1 / this.frameEma < wanted ? this.slow + dt : Math.max(0, this.slow - dt * 2);
    if (this.slow < AUTO_WINDOW) return;
    this.slow = 0;
    this.applyQuality('medium');
    const notify = this.onAutoDowngrade;
    this.onAutoDowngrade = null;
    notify('medium');
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
