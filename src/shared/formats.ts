/**
 * Match formats. Every one is a battle royale (the ring closes, the last car
 * standing wins); they differ in the vehicle and how many ride in it:
 *
 *   solo    12 armed brawlers, one driver each (the car is the weapon)
 *   duos     6 cars, a driver and a gunner leaning out of the window
 *   squads   3 armoured trucks, a driver and three window gunners
 *
 * Kept free of any import so the protocol and the page can name a format.
 */
export const FORMAT_IDS = ['solo', 'duos', 'squads'] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export const FORMATS: Record<FormatId, { name: string; blurb: string; cars: number; vehicle: 'solo' | 'coupe' | 'suv'; seats: number }> = {
  solo: { name: 'Solo', blurb: 'every car for itself', cars: 12, vehicle: 'solo', seats: 1 },
  duos: { name: 'Duos', blurb: 'a driver and a gunner per car', cars: 6, vehicle: 'coupe', seats: 2 },
  squads: { name: 'Squads', blurb: 'a driver and three gunners per truck', cars: 3, vehicle: 'suv', seats: 4 },
};

export function isFormatId(value: unknown): value is FormatId {
  return typeof value === 'string' && (FORMAT_IDS as readonly string[]).includes(value);
}
