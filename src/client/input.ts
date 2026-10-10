/**
 * Keyboard + mouse, and GAMEPAD, input, converted into simulation input.
 *
 * DESIGN.md §15: input is expressed as ACTIONS (throttle, steer, handbrake,
 * boost) rather than raw key codes, so a gamepad can be slotted in later
 * without touching the simulation or the vehicle code.
 *
 * Digital keys are smoothed into analogue values — a keyboard is on/off, but a
 * car's steering is not, and raw 0→1 jumps feel terrible to drive.
 */

import { clamp, damp } from '../shared/math';
import type { VehicleInput } from '../shared/vehicle';
import { TouchControls } from './touch';

const STEER_RATE = 9; // how fast the steering wheel reaches full lock
const STEER_RETURN_RATE = 14; // how fast it self-centres
/**
 * How fast a held throttle key builds to full. Slower than the steering on
 * purpose: a keyboard is on/off, and ramping the throttle in over ~0.6 s is
 * what stops every keypress feeling like flooring it.
 */
const THROTTLE_RATE = 5;

/**
 * Gamepad: the W3C "standard" layout (Xbox / PlayStation / most others in a
 * browser). Triggers drive, so the guns go on the bumpers:
 *
 *   left stick  steer            RT / LT  throttle / brake–reverse (analogue)
 *   right stick aim              RB       twin machine guns   LB  roof RPG
 *   X           handbrake        B / L3   boost               Y   reload
 *   Start       menu             D-pad + A / B   move and choose in menus
 */
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, UP: 12, DOWN: 13 } as const;
const PAD_DEADZONE = 0.14;
/** Full-deflection aim speed, rad/s. A response curve keeps fine aim near centre. */
const PAD_AIM_YAW = 2.6;
const PAD_AIM_PITCH = 1.6;
/** A pad counts as "in use" this long after its last input. */
const PAD_ACTIVE_MS = 8000;

/** Deadzone, rescaled so the usable range still reaches ±1, then a curve. */
const stick = (v: number, power = 1.6): number => {
  const a = Math.abs(v);
  if (a < PAD_DEADZONE) return 0;
  return Math.sign(v) * ((a - PAD_DEADZONE) / (1 - PAD_DEADZONE)) ** power;
};

export type PadNav = 'up' | 'down' | 'confirm' | 'back';

export class Input {
  private keys = new Set<string>();
  private canvas: HTMLCanvasElement | null = null;

  /** Orbit offsets applied on top of the car's heading. */
  lookYaw = 0;
  lookPitch = 0;
  locked = false;
  /** Pointer lock is only worth offering once we are actually in a match. */
  enabled = false;

  /** Analogue state, smoothed from the digital keys. */
  private steer = 0;
  private throttle = 0;
  /** Trigger held. Automatic weapons fire while this is true. */
  private firing = false;
  /** Set on the trigger-down edge, for semi-automatic weapons. */
  private firePressed = false;
  /** Right mouse button: the secondary trigger (a car's heavy weapon). */
  private firing2 = false;
  private fire2Pressed = false;
  private reloadRequested = false;
  private switchRequested: number | null = null;

  /** Gamepad state, refreshed by `poll` once a frame. */
  private pad = {
    connected: false,
    steer: 0,
    throttle: 0,
    handbrake: false,
    boost: false,
    fire: false,
    fire2: false,
    lastUsed: 0,
    previous: [] as boolean[],
  };
  private menuPressed = false;
  private navQueue: PadNav[] = [];
  /** On-screen controls, on a touch device (null elsewhere). */
  touch: TouchControls | null = null;

  /** Add the on-screen touch controls; they aim the same view the mouse does. */
  attachTouch(): TouchControls {
    this.touch = new TouchControls((dYaw, dPitch) => {
      this.lookYaw = clamp(this.lookYaw + dYaw, -Math.PI, Math.PI);
      this.lookPitch = clamp(this.lookPitch + dPitch, -1.2, 1.2);
    });
    return this.touch;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.reloadRequested = true;
      if (e.code === 'Digit1') this.switchRequested = 0;
      if (e.code === 'Digit2') this.switchRequested = 1;
      if (e.code === 'Digit3') this.switchRequested = 2;
      // Stop the page scrolling when driving.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('click', () => {
      if (this.locked || !this.enabled) return;
      // Rejects when the browser won't grant it — headless, or a window that is
      // not focused. Unhandled, that is a console error for a real player too.
      const request = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (request && typeof request.catch === 'function') request.catch(() => {});
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.firing = true;
        this.firePressed = true;
      }
      if (e.button === 2) {
        this.firing2 = true;
        this.fire2Pressed = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.firing2 = false;
    });
    // Right-click is a trigger, not a menu.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => {
      this.firing = false;
      this.firing2 = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Moving the mouse right swings the view right, which means the camera
      // orbits further round the car in the negative direction.
      this.lookYaw -= e.movementX * 0.0022;
      this.lookPitch = clamp(this.lookPitch + e.movementY * 0.0022, -1.2, 1.2);
      this.lookYaw = clamp(this.lookYaw, -Math.PI, Math.PI);
    });
  }

  /**
   * Read the gamepad. Once a frame, before `update`: the browser exposes pads
   * by polling, not events. `aiming` is false while a menu is open, so the
   * right stick does not swing the guns behind it.
   */
  poll(dt: number, aiming: boolean): void {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const candidate of pads) if (candidate?.connected) gp = gp ?? candidate;
    const pad = this.pad;
    if (!gp) {
      pad.connected = false;
      pad.steer = pad.throttle = 0;
      pad.handbrake = pad.boost = pad.fire = pad.fire2 = false;
      return;
    }
    pad.connected = true;
    const held = (i: number): boolean => gp!.buttons[i]?.pressed ?? false;
    const value = (i: number): number => gp!.buttons[i]?.value ?? 0;
    const pressed = (i: number): boolean => held(i) && !pad.previous[i];

    pad.steer = stick(gp.axes[0] ?? 0, 1.4);
    // Triggers are analogue: a light squeeze is a light throttle.
    const rt = value(PAD.RT);
    const lt = value(PAD.LT);
    pad.throttle = (rt > 0.05 ? rt : 0) - (lt > 0.05 ? lt : 0);
    pad.handbrake = held(PAD.X);
    pad.boost = held(PAD.B) || held(PAD.L3);
    pad.fire = held(PAD.RB);
    pad.fire2 = held(PAD.LB);
    if (pressed(PAD.RB)) this.firePressed = true;
    if (pressed(PAD.LB)) this.fire2Pressed = true;
    if (pressed(PAD.Y)) this.reloadRequested = true;
    if (pressed(PAD.START)) this.menuPressed = true;
    if (pressed(PAD.UP)) this.navQueue.push('up');
    if (pressed(PAD.DOWN)) this.navQueue.push('down');
    if (pressed(PAD.A)) this.navQueue.push('confirm');
    if (pressed(PAD.B)) this.navQueue.push('back');

    const rx = stick(gp.axes[2] ?? 0, 2);
    const ry = stick(gp.axes[3] ?? 0, 2);
    if (aiming) {
      // Same convention as the mouse: right swings the view right.
      this.lookYaw = clamp(this.lookYaw - rx * PAD_AIM_YAW * dt, -Math.PI, Math.PI);
      this.lookPitch = clamp(this.lookPitch + ry * PAD_AIM_PITCH * dt, -1.2, 1.2);
    }

    const any =
      pad.steer !== 0 || pad.throttle !== 0 || rx !== 0 || ry !== 0 || gp.buttons.some((b) => b.pressed);
    if (any) pad.lastUsed = performance.now();
    pad.previous = gp.buttons.map((b) => b.pressed);
  }

  /** A gamepad is connected and has been used recently. */
  get padActive(): boolean {
    return this.pad.connected && performance.now() - this.pad.lastUsed < PAD_ACTIVE_MS;
  }

  get padConnected(): boolean {
    return this.pad.connected;
  }

  /** True once after Start was pressed. */
  consumeMenuButton(): boolean {
    const value = this.menuPressed || (this.touch?.consumeMenu() ?? false);
    this.menuPressed = false;
    return value;
  }

  /** Menu navigation from the pad since the last call. */
  drainNav(): PadNav[] {
    const out = this.navQueue;
    this.navQueue = [];
    return out;
  }

  private down(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Advance the smoothed analogue state and return this tick's input. */
  update(dt: number): VehicleInput {
    let steerTarget = 0;
    if (this.down('KeyA', 'ArrowLeft')) steerTarget -= 1;
    if (this.down('KeyD', 'ArrowRight')) steerTarget += 1;

    let throttleTarget = 0;
    if (this.down('KeyW', 'ArrowUp')) throttleTarget += 1;
    if (this.down('KeyS', 'ArrowDown')) throttleTarget -= 1;

    const pad = this.pad;
    const touch = this.touch?.state;
    if (touch && (touch.steer !== 0 || touch.throttle !== 0)) {
      // The touch stick is analogue too.
      this.steer = damp(this.steer, touch.steer, 20, dt);
      this.throttle = damp(this.throttle, touch.throttle, 14, dt);
      return {
        throttle: this.throttle,
        steer: this.steer,
        handbrake: touch.handbrake,
        boost: touch.boost,
      };
    }
    if (pad.steer !== 0) {
      // An analogue stick is already smooth: follow it closely, no ramp.
      this.steer = damp(this.steer, pad.steer, 24, dt);
    } else {
      // Steering snaps on, but self-centres more slowly, which feels natural.
      const steerRate = steerTarget === 0 ? STEER_RETURN_RATE : STEER_RATE;
      this.steer = damp(this.steer, steerTarget, steerRate, dt);
    }
    if (pad.throttle !== 0) this.throttle = damp(this.throttle, pad.throttle, 18, dt);
    else this.throttle = damp(this.throttle, throttleTarget, THROTTLE_RATE, dt);

    return {
      throttle: this.throttle,
      steer: this.steer,
      handbrake: this.down('Space') || pad.handbrake || (touch?.handbrake ?? false),
      boost: this.down('ShiftLeft', 'ShiftRight') || pad.boost || (touch?.boost ?? false),
    };
  }

  /** True while the car is being asked to slide — used for HUD feedback. */
  get wantsHandbrake(): boolean {
    return this.down('Space') || this.pad.handbrake || (this.touch?.state.handbrake ?? false);
  }

  /** True while the trigger is held (mouse or RB). */
  get wantsFire(): boolean {
    return this.firing || this.pad.fire || (this.touch?.state.fire ?? false);
  }

  /** True once after the trigger goes down. Consumed by the caller. */
  consumeFirePress(): boolean {
    const value = this.firePressed || (this.touch?.firePressed ?? false);
    this.firePressed = false;
    if (this.touch) this.touch.firePressed = false;
    return value;
  }

  /** True while the secondary (right-mouse) trigger is held. */
  get wantsFire2(): boolean {
    return this.firing2 || this.pad.fire2 || (this.touch?.state.fire2 ?? false);
  }

  /** True once after the secondary trigger goes down. Consumed by the caller. */
  consumeFire2Press(): boolean {
    const value = this.fire2Pressed || (this.touch?.fire2Pressed ?? false);
    this.fire2Pressed = false;
    if (this.touch) this.touch.fire2Pressed = false;
    return value;
  }

  /** True once after a reload key press. */
  consumeReload(): boolean {
    const value = this.reloadRequested || (this.touch?.reloadPressed ?? false);
    this.reloadRequested = false;
    if (this.touch) this.touch.reloadPressed = false;
    return value;
  }

  /** Weapon slot requested by a number key, or null. Consumed once. */
  consumeSwitch(): number | null {
    const value = this.switchRequested;
    this.switchRequested = null;
    return value;
  }

  /** Current smoothed throttle, for diagnostics. */
  get throttleValue(): number {
    return this.throttle;
  }

  /** Keys currently held, for diagnostics. */
  get heldKeys(): string[] {
    return [...this.keys];
  }
}
