/**
 * Temporary drift benchmark — prints the shape of a drift over time.
 * Not part of the test suite; used to tune by data rather than guesswork.
 *
 *   npx tsx scripts/driftbench.ts
 */

import { TICK, VEHICLE, VEHICLE_CLASSES } from '../src/shared/config';

const TEST_SPEC = VEHICLE_CLASSES.suv;
import {
  createVehicle,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../src/shared/vehicle';

const DT = TICK.dt;
const NEUTRAL: VehicleInput = { throttle: 0, steer: 0, handbrake: false, boost: false };
const input = (p: Partial<VehicleInput>): VehicleInput => ({ ...NEUTRAL, ...p });

const LANE_X = -100;
const LANE_Z = -20;
const LANE_YAW = -Math.PI / 2;

const kmh = (v: number) => (v * 3.6).toFixed(0);

function bench(label: string, steer: (t: number) => number, seconds = 2.2): void {
  const s: VehicleState = createVehicle(LANE_X, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW, TEST_SPEC);
  // build speed
  for (let t = 0; t < 300; t++) stepVehicle(s, input({ throttle: 1 }), DT);
  const entry = Math.hypot(s.vel.x, s.vel.z);
  console.log(`\n${label}  (entry ${kmh(entry)} km/h)`);
  console.log('   t     speed   slip   yaw°   drift-angle°');

  const ticks = Math.round(seconds / DT);
  let peakSlip = 0;
  for (let t = 0; t < ticks; t++) {
    stepVehicle(s, input({ throttle: 1, steer: steer(t * DT), handbrake: true }), DT);
    const speed = Math.hypot(s.vel.x, s.vel.z);
    const slip = Math.abs(s.slipSpeed);
    peakSlip = Math.max(peakSlip, slip);
    if (t % 15 === 0) {
      const travelYaw = Math.atan2(-s.vel.x, -s.vel.z);
      let angle = ((travelYaw - s.yaw) * 180) / Math.PI;
      while (angle > 180) angle -= 360;
      while (angle < -180) angle += 360;
      console.log(
        `  ${(t * DT).toFixed(2)}  ${kmh(speed).padStart(5)}  ${slip.toFixed(1).padStart(5)}  ${(((s.yaw * 180) / Math.PI) % 360).toFixed(0).padStart(5)}  ${angle.toFixed(0).padStart(12)}`,
      );
    }
  }
  const exit = Math.hypot(s.vel.x, s.vel.z);
  console.log(
    `  END   ${kmh(exit)} km/h (${((exit / entry) * 100).toFixed(0)}% retained), peak slip ${peakSlip.toFixed(1)} m/s`,
  );
}

console.log('engineForce', VEHICLE.engineForce, '| gripHB', VEHICLE.lateralGripHandbrake);
console.log('hbBraking', VEHICLE.handbrakeBraking, '| falloff', VEHICLE.handbrakeBrakingFalloff, '| drive', VEHICLE.handbrakeDriveFactor);

// Full lock the whole way: a donut.
bench('A. FULL LOCK (donut)', () => 1);

// Turn in, then counter-steer to hold the slide — how a player actually drifts.
bench('B. TURN IN THEN COUNTER-STEER', (t) => (t < 0.7 ? 1 : -0.55));

// A gentle, held corner.
bench('C. HELD PARTIAL STEER', () => 0.5);
