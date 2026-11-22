// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "./geo-coordinate.ts";

interface CityEntry {
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
}

const entries = {
  newYork: { name: "New York", latitude: 40.73, longitude: -73.98 },
  losAngeles: { name: "Los Angeles", latitude: 34.0522, longitude: -118.2437 },
  sanFrancisco: { name: "San Francisco", latitude: 37.7749, longitude: -122.4194 },
  chicago: { name: "Chicago", latitude: 41.8781, longitude: -87.6298 },
  washington: { name: "Washington", latitude: 38.9072, longitude: -77.0369 },
  boston: { name: "Boston", latitude: 42.3601, longitude: -71.0589 },
  miami: { name: "Miami", latitude: 25.7617, longitude: -80.1918 },
  seattle: { name: "Seattle", latitude: 47.6062, longitude: -122.3321 },
  lasVegas: { name: "Las Vegas", latitude: 36.1699, longitude: -115.1398 },
  toronto: { name: "Toronto", latitude: 43.6532, longitude: -79.3832 },
  vancouver: { name: "Vancouver", latitude: 49.2827, longitude: -123.1207 },
  montreal: { name: "Montreal", latitude: 45.5019, longitude: -73.5674 },
  mexicoCity: { name: "Mexico City", latitude: 19.4326, longitude: -99.1332 },
  rioDeJaneiro: { name: "Rio de Janeiro", latitude: -22.9068, longitude: -43.1729 },
  saoPaulo: { name: "São Paulo", latitude: -23.5505, longitude: -46.6333 },
  buenosAires: { name: "Buenos Aires", latitude: -34.6037, longitude: -58.3816 },
  lima: { name: "Lima", latitude: -12.0464, longitude: -77.0428 },
  bogota: { name: "Bogotá", latitude: 4.711, longitude: -74.0721 },
  santiago: { name: "Santiago", latitude: -33.4489, longitude: -70.6693 },
  london: { name: "London", latitude: 51.5074, longitude: -0.1278 },
  paris: { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
  berlin: { name: "Berlin", latitude: 52.52, longitude: 13.405 },
  madrid: { name: "Madrid", latitude: 40.4168, longitude: -3.7038 },
  barcelona: { name: "Barcelona", latitude: 41.3874, longitude: 2.1686 },
  rome: { name: "Rome", latitude: 41.9028, longitude: 12.4964 },
  milan: { name: "Milan", latitude: 45.4642, longitude: 9.19 },
  amsterdam: { name: "Amsterdam", latitude: 52.3676, longitude: 4.9041 },
  vienna: { name: "Vienna", latitude: 48.2082, longitude: 16.3738 },
  prague: { name: "Prague", latitude: 50.0755, longitude: 14.4378 },
  lisbon: { name: "Lisbon", latitude: 38.7223, longitude: -9.1393 },
  athens: { name: "Athens", latitude: 37.9838, longitude: 23.7275 },
  stockholm: { name: "Stockholm", latitude: 59.3293, longitude: 18.0686 },
  copenhagen: { name: "Copenhagen", latitude: 55.6761, longitude: 12.5683 },
  oslo: { name: "Oslo", latitude: 59.9139, longitude: 10.7522 },
  helsinki: { name: "Helsinki", latitude: 60.1699, longitude: 24.9384 },
  dublin: { name: "Dublin", latitude: 53.3498, longitude: -6.2603 },
  brussels: { name: "Brussels", latitude: 50.8503, longitude: 4.3517 },
  zurich: { name: "Zurich", latitude: 47.3769, longitude: 8.5417 },
  munich: { name: "Munich", latitude: 48.1351, longitude: 11.582 },
  warsaw: { name: "Warsaw", latitude: 52.2297, longitude: 21.0122 },
  budapest: { name: "Budapest", latitude: 47.4979, longitude: 19.0402 },
  istanbul: { name: "Istanbul", latitude: 41.0082, longitude: 28.9784 },
  moscow: { name: "Moscow", latitude: 55.7558, longitude: 37.6173 },
  saintPetersburg: { name: "Saint Petersburg", latitude: 59.9311, longitude: 30.3609 },
  kyiv: { name: "Kyiv", latitude: 50.4501, longitude: 30.5234 },
  dubai: { name: "Dubai", latitude: 25.2048, longitude: 55.2708 },
  telAviv: { name: "Tel Aviv", latitude: 32.0853, longitude: 34.7818 },
  cairo: { name: "Cairo", latitude: 30.0444, longitude: 31.2357 },
  capeTown: { name: "Cape Town", latitude: -33.9249, longitude: 18.4241 },
  johannesburg: { name: "Johannesburg", latitude: -26.2041, longitude: 28.0473 },
  nairobi: { name: "Nairobi", latitude: -1.2921, longitude: 36.8219 },
  lagos: { name: "Lagos", latitude: 6.5244, longitude: 3.3792 },
  marrakesh: { name: "Marrakesh", latitude: 31.6295, longitude: -7.9811 },
  tokyo: { name: "Tokyo", latitude: 35.6812, longitude: 139.7671 },
  osaka: { name: "Osaka", latitude: 34.6937, longitude: 135.5023 },
  seoul: { name: "Seoul", latitude: 37.5665, longitude: 126.978 },
  beijing: { name: "Beijing", latitude: 39.9042, longitude: 116.4074 },
  shanghai: { name: "Shanghai", latitude: 31.2304, longitude: 121.4737 },
  hongKong: { name: "Hong Kong", latitude: 22.3193, longitude: 114.1694 },
  taipei: { name: "Taipei", latitude: 25.033, longitude: 121.5654 },
  singapore: { name: "Singapore", latitude: 1.3521, longitude: 103.8198 },
  bangkok: { name: "Bangkok", latitude: 13.7563, longitude: 100.5018 },
  kualaLumpur: { name: "Kuala Lumpur", latitude: 3.139, longitude: 101.6869 },
  jakarta: { name: "Jakarta", latitude: -6.2088, longitude: 106.8456 },
  manila: { name: "Manila", latitude: 14.5995, longitude: 120.9842 },
  hanoi: { name: "Hanoi", latitude: 21.0278, longitude: 105.8342 },
  mumbai: { name: "Mumbai", latitude: 19.076, longitude: 72.8777 },
  delhi: { name: "Delhi", latitude: 28.6139, longitude: 77.209 },
  sydney: { name: "Sydney", latitude: -33.8688, longitude: 151.2093 },
  melbourne: { name: "Melbourne", latitude: -37.8136, longitude: 144.9631 },
  auckland: { name: "Auckland", latitude: -36.8485, longitude: 174.7633 },
} as const satisfies Record<string, CityEntry>;

/**
 * Well-known cities and where they are, for a map that opens over one or
 * flies to one without the app keeping the coordinates:
 *
 * ```ts
 * ImmersiveMapCameraPosition.city("paris");
 * ImmersiveMapCameraPosition.city("tokyo", 13);
 * ```
 *
 * Each coordinate is the city's centre, as its maps usually mark it. The
 * list is a convenience and not a gazetteer: a place it does not hold is an
 * `ImmersiveMapCameraPosition` with its own coordinates.
 */
export type ImmersiveMapCity = keyof typeof entries;

export const ImmersiveMapCity = {
  /** Every city, in the order the Swift enum declares them. */
  allCases: Object.freeze(Object.keys(entries)) as readonly ImmersiveMapCity[],

  /** The city's name in English. */
  name(city: ImmersiveMapCity): string {
    return entries[city].name;
  },

  /** The city's centre. */
  coordinate(city: ImmersiveMapCity): GeoCoordinate {
    const entry = entries[city];
    return { latitude: entry.latitude, longitude: entry.longitude };
  },
} as const;
