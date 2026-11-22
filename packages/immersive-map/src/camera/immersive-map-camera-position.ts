// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapCity } from "../geo/immersive-map-city.ts";

const cityZoom = 11;

/** Where the camera is, in the terms an app speaks: degrees, a zoom, and radians of bearing and pitch. */
export interface ImmersiveMapCameraPosition {
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly zoom: number;
  /** Radians from north, clockwise as the map turns. */
  readonly bearing: number;
  /** Radians from straight down. */
  readonly pitch: number;
}

export const ImmersiveMapCameraPosition = {
  default: Object.freeze({ latitudeDegrees: 0, longitudeDegrees: 0, zoom: 0, bearing: 0, pitch: 0 }) as ImmersiveMapCameraPosition,

  /** A position, north up and from straight above unless a bearing and a pitch are given. */
  make(latitudeDegrees: number, longitudeDegrees: number, zoom: number, bearing = 0, pitch = 0): ImmersiveMapCameraPosition {
    return { latitudeDegrees, longitudeDegrees, zoom, bearing, pitch };
  },

  /** The zoom a city is seen whole from, `city`'s default. */
  cityZoom,

  /**
   * The camera over a city's centre (`ImmersiveMapCity`), from straight above
   * and north up unless a bearing and a pitch are given. The default zoom
   * shows the city whole. Raise it to open on its centre's streets.
   */
  city(city: ImmersiveMapCity, zoom: number = cityZoom, bearing = 0, pitch = 0): ImmersiveMapCameraPosition {
    const coordinate = ImmersiveMapCity.coordinate(city);
    return { latitudeDegrees: coordinate.latitude, longitudeDegrees: coordinate.longitude, zoom, bearing, pitch };
  },
} as const;

/** The path a flight takes over the map. */
export type CameraFlightRouteStyle = "automatic" | "mercatorShortestPath" | "greatCircle";

/**
 * How a flight's zoom runs.
 *
 * - `direct`: zoom interpolates directly from the start value to the target.
 * - `overviewFirst`: the cinematic van Wijk and Nuij arc. The camera first
 *   gains altitude (the farther the target, the higher the apex, up to a
 *   globe view), covers most of the distance from above, and dives toward
 *   the target.
 */
export type CameraFlightAltitudeStyle = "direct" | "overviewFirst";

export interface CameraFlightOptions {
  readonly duration: number;
  readonly routeStyle: CameraFlightRouteStyle;
  readonly altitudeStyle: CameraFlightAltitudeStyle;
}

const defaultFlightDuration = 1.35;

export const CameraFlightOptions = {
  default: Object.freeze({ duration: defaultFlightDuration, routeStyle: "automatic", altitudeStyle: "direct" }) as CameraFlightOptions,

  /** A non-finite duration falls back to the default, and a negative one is zero. */
  make(duration: number, routeStyle: CameraFlightRouteStyle = "automatic", altitudeStyle: CameraFlightAltitudeStyle = "direct"): CameraFlightOptions {
    const sanitizedDuration = Number.isFinite(duration) ? duration : defaultFlightDuration;
    return { duration: Math.max(0, sanitizedDuration), routeStyle, altitudeStyle };
  },
} as const;
