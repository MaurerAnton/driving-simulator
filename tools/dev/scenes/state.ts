// SPDX-License-Identifier: AGPL-3.0-only
/** A vehicle standing still with the engine running: the visual state the models are drawn from, for previews. */
import type { CarVisualState } from '../../../src/render/car.ts';

export function standing(over: Partial<CarVisualState> = {}): CarVisualState {
  return {
    speedKmh: 0,
    rpm: 900,
    gear: 1,
    indicator: 0,
    hazard: false,
    blinkOn: false,
    lowBeam: true,
    highBeam: false,
    handbrake: false,
    ignition: true,
    engineRunning: true,
    abs: false,
    seatbelt: true,
    fuel: 0.7,
    automatic: false,
    showGear: true,
    odometerKm: 1234,
    steerWheel: 0,
    wheelSteer: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    wheelY: [0.31, 0.31, 0.31, 0.31],
    clutch: 0,
    brake: 0,
    throttle: 0,
    handbrakeLever: 0,
    braking: false,
    reversing: false,
    ...over,
  };
}
