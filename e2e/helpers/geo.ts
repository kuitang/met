import type { BrowserContext } from '@playwright/test';

/** A point on a walking polyline (decimal degrees, WGS84). */
export interface LatLon {
  lat: number;
  lon: number;
}

export interface WalkOptions {
  /** Delay between successive fixes (ms). */
  intervalMs?: number;
  /** Std-dev of Gaussian position jitter, in meters. */
  jitterM?: number;
  /** Reported accuracy of each fix, in meters (indoor GPS reality: 30–100). */
  accuracyM?: number;
}

// Meters per degree at the Met's latitude (~40.78° N).
const NYC_LAT_DEG = 40.78;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((NYC_LAT_DEG * Math.PI) / 180); // ≈ 84,300

/** Standard normal sample (Box–Muller). */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Emit a single geolocation fix. */
export async function fix(
  context: BrowserContext,
  lat: number,
  lon: number,
  accuracyM = 40,
): Promise<void> {
  await context.setGeolocation({ latitude: lat, longitude: lon, accuracy: accuracyM });
}

/** Simulate a GPS outage: clears the emulated position. */
export async function gpsOutage(context: BrowserContext): Promise<void> {
  await context.setGeolocation(null);
}

/**
 * Walk a polyline: feeds each point into setGeolocation with Gaussian jitter
 * (so watchPosition in the app sees realistic noisy indoor fixes), pausing
 * intervalMs between fixes. Resolves after the last fix has been emitted and
 * its interval elapsed.
 */
export async function walkAlong(
  context: BrowserContext,
  coords: LatLon[],
  { intervalMs = 1500, jitterM = 8, accuracyM = 40 }: WalkOptions = {},
): Promise<void> {
  for (const { lat, lon } of coords) {
    const latJitter = (gaussian() * jitterM) / M_PER_DEG_LAT;
    const lonJitter = (gaussian() * jitterM) / M_PER_DEG_LON;
    await context.setGeolocation({
      latitude: lat + latJitter,
      longitude: lon + lonJitter,
      accuracy: accuracyM,
    });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
