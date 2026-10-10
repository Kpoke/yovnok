/**
 * Touch controls (phones and tablets), twin-stick:
 *
 *   left thumb   a floating stick wherever it lands: up = gas, down = brake /
 *                reverse, sideways = steer
 *   right thumb  drag anywhere to aim; MG (hold) and RPG buttons, which also
 *                aim while the thumb slides on them; BOOST and DRIFT (hold);
 *                RELOAD
 *   ☰            the in-game menu
 *
 * It writes the same actions the keyboard and the gamepad do (see Input), so
 * nothing downstream knows a finger was involved. Aim assist lives in main.ts.
 */

import { clamp } from '../shared/math';

/** Aim speed: radians per CSS pixel of drag. */
const AIM_X = 0.0062;
const AIM_Y = 0.0045;
/** The stick's travel, in CSS pixels, for full deflection. */
const STICK_RADIUS = 56;
const STICK_DEADZONE = 0.12;

export type TouchState = {
  steer: number;
  throttle: number;
  handbrake: boolean;
  boost: boolean;
  fire: boolean;
  fire2: boolean;
};

type Finger = { id: number; role: 'stick' | 'aim' | 'fire' | 'fire2'; x: number; y: number; ox: number; oy: number };

export class TouchControls {
  readonly state: TouchState = { steer: 0, throttle: 0, handbrake: false, boost: false, fire: false, fire2: false };
  /** Set on a press edge; consumed by Input. */
  firePressed = false;
  fire2Pressed = false;
  reloadPressed = false;
  menuPressed = false;
  /** Seconds since a finger last touched the controls (aim assist eases off when idle). */
  lastTouch = 0;

  private readonly root: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly fingers = new Map<number, Finger>();
  private visible = false;

  constructor(
    /** Called with an aim delta (radians) to apply to the view. */
    private readonly aim: (dYaw: number, dPitch: number) => void,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'touch';
    this.root.className = 'hidden';
    this.root.innerHTML = `
      <div class="touch-zone left"></div>
      <div class="touch-zone right"></div>
      <div class="stick-base hidden"><div class="stick-knob"></div></div>
      <button class="touch-btn menu" data-act="menu" aria-label="Menu">☰</button>
      <button class="touch-btn fire" data-act="fire">MG</button>
      <button class="touch-btn fire2" data-act="fire2">RPG</button>
      <button class="touch-btn boost" data-act="boost">BOOST</button>
      <button class="touch-btn drift" data-act="drift">DRIFT</button>
      <button class="touch-btn reload" data-act="reload">↻</button>`;
    document.querySelector('.hud')?.appendChild(this.root);
    this.stickBase = this.root.querySelector('.stick-base')!;
    this.stickKnob = this.root.querySelector('.stick-knob')!;

    const left = this.root.querySelector<HTMLElement>('.touch-zone.left')!;
    const right = this.root.querySelector<HTMLElement>('.touch-zone.right')!;
    const opts = { passive: false } as const;

    left.addEventListener('touchstart', (e) => this.begin(e, 'stick'), opts);
    right.addEventListener('touchstart', (e) => this.begin(e, 'aim'), opts);
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.touch-btn')) {
      const act = button.dataset.act!;
      button.addEventListener(
        'touchstart',
        (e) => {
          e.preventDefault();
          this.lastTouch = performance.now();
          button.classList.add('held');
          if (act === 'fire' || act === 'fire2') {
            this.begin(e, act);
            return;
          }
          if (act === 'boost') this.state.boost = true;
          if (act === 'drift') this.state.handbrake = true;
          if (act === 'reload') this.reloadPressed = true;
          if (act === 'menu') this.menuPressed = true;
        },
        opts,
      );
      const release = (e: TouchEvent): void => {
        e.preventDefault();
        if (act === 'fire' || act === 'fire2') return; // released with the finger (end)
        // Still held by another finger? (rare; release on any lift)
        button.classList.remove('held');
        if (act === 'boost') this.state.boost = false;
        if (act === 'drift') this.state.handbrake = false;
      };
      button.addEventListener('touchend', release, opts);
      button.addEventListener('touchcancel', release, opts);
    }
    window.addEventListener('touchmove', (e) => this.move(e), opts);
    window.addEventListener('touchend', (e) => this.end(e), opts);
    window.addEventListener('touchcancel', (e) => this.end(e), opts);
  }

  /** Show the controls (in a live match) or hide them, releasing everything. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.releaseAll();
  }

  private releaseAll(): void {
    this.fingers.clear();
    Object.assign(this.state, { steer: 0, throttle: 0, handbrake: false, boost: false, fire: false, fire2: false });
    this.stickBase.classList.add('hidden');
    for (const b of this.root.querySelectorAll('.held')) b.classList.remove('held');
  }

  private begin(e: TouchEvent, role: Finger['role']): void {
    e.preventDefault();
    this.lastTouch = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      if (role === 'stick' && [...this.fingers.values()].some((f) => f.role === 'stick')) continue;
      this.fingers.set(t.identifier, { id: t.identifier, role, x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY });
      if (role === 'stick') {
        // The stick appears under the thumb.
        this.stickBase.classList.remove('hidden');
        this.stickBase.style.left = `${t.clientX}px`;
        this.stickBase.style.top = `${t.clientY}px`;
        this.stickKnob.style.transform = 'translate(-50%, -50%)';
      }
      if (role === 'fire') {
        this.state.fire = true;
        this.firePressed = true;
      }
      if (role === 'fire2') {
        this.state.fire2 = true;
        this.fire2Pressed = true;
      }
    }
  }

  private move(e: TouchEvent): void {
    if (this.fingers.size === 0) return;
    e.preventDefault();
    this.lastTouch = performance.now();
    for (const t of Array.from(e.changedTouches)) {
      const f = this.fingers.get(t.identifier);
      if (!f) continue;
      const dx = t.clientX - f.x;
      const dy = t.clientY - f.y;
      f.x = t.clientX;
      f.y = t.clientY;
      if (f.role === 'stick') {
        let sx = (f.x - f.ox) / STICK_RADIUS;
        let sy = (f.y - f.oy) / STICK_RADIUS;
        const length = Math.hypot(sx, sy);
        if (length > 1) {
          // Past full travel the base follows the thumb, so it never runs out.
          f.ox += ((sx / length) * (length - 1)) * STICK_RADIUS;
          f.oy += ((sy / length) * (length - 1)) * STICK_RADIUS;
          sx /= length;
          sy /= length;
          this.stickBase.style.left = `${f.ox}px`;
          this.stickBase.style.top = `${f.oy}px`;
        }
        this.stickKnob.style.transform = `translate(calc(-50% + ${sx * STICK_RADIUS}px), calc(-50% + ${sy * STICK_RADIUS}px))`;
        const curve = (v: number): number => (Math.abs(v) < STICK_DEADZONE ? 0 : Math.sign(v) * ((Math.abs(v) - STICK_DEADZONE) / (1 - STICK_DEADZONE)) ** 1.3);
        this.state.steer = clamp(curve(sx), -1, 1);
        this.state.throttle = clamp(curve(-sy), -1, 1);
      } else {
        // Aim: the right thumb, including a thumb sliding on a fire button.
        this.aim(-dx * AIM_X, dy * AIM_Y);
      }
    }
  }

  private end(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) {
      const f = this.fingers.get(t.identifier);
      if (!f) continue;
      this.fingers.delete(t.identifier);
      if (f.role === 'stick') {
        this.state.steer = 0;
        this.state.throttle = 0;
        this.stickBase.classList.add('hidden');
      }
      if (f.role === 'fire') {
        this.state.fire = false;
        this.root.querySelector('.touch-btn.fire')?.classList.remove('held');
      }
      if (f.role === 'fire2') {
        this.state.fire2 = false;
        this.root.querySelector('.touch-btn.fire2')?.classList.remove('held');
      }
    }
  }

  /** True once after ☰. */
  consumeMenu(): boolean {
    const v = this.menuPressed;
    this.menuPressed = false;
    return v;
  }
}
