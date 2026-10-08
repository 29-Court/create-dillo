import { FieldDefinition } from "./schema.js";

export type GeoPoint = {
  latitude: number;
  longitude: number;
  altitude?: number;
};

export type DistanceUnit = "meters" | "kilometers" | "miles";

export class GeoFieldDefinition<
  TRequired extends boolean = true,
  THasDefault extends boolean = false,
> extends FieldDefinition<GeoPoint, TRequired, THasDefault> {
  override optional(): GeoFieldDefinition<false, THasDefault> {
    return new GeoFieldDefinition({ ...this.config, required: false });
  }

  override default(value: GeoPoint): GeoFieldDefinition<TRequired, true> {
    assertGeoPoint(value);
    return new GeoFieldDefinition({ ...this.config, default: value as never });
  }

  /** Create a composite latitude/longitude index for column-backed storage. */
  index(name = "location"): GeoFieldDefinition<TRequired, THasDefault> {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) {
      throw new TypeError("Geo index names must begin with a letter and use letters, numbers, or underscores.");
    }
    return new GeoFieldDefinition({ ...this.config, geoIndex: name });
  }

  minAltitude(meters: number): GeoFieldDefinition<TRequired, THasDefault> {
    if (!Number.isFinite(meters)) throw new TypeError("Minimum altitude must be finite.");
    if (this.config.maxAltitude !== undefined && meters > this.config.maxAltitude) {
      throw new TypeError("Minimum altitude cannot exceed maximum altitude.");
    }
    return new GeoFieldDefinition({ ...this.config, minAltitude: meters });
  }

  maxAltitude(meters: number): GeoFieldDefinition<TRequired, THasDefault> {
    if (!Number.isFinite(meters)) throw new TypeError("Maximum altitude must be finite.");
    if (this.config.minAltitude !== undefined && meters < this.config.minAltitude) {
      throw new TypeError("Maximum altitude cannot be below minimum altitude.");
    }
    return new GeoFieldDefinition({ ...this.config, maxAltitude: meters });
  }
}

export function geo(): GeoFieldDefinition {
  return new GeoFieldDefinition({ type: "geo", required: true });
}

export function assertGeoPoint(value: unknown): asserts value is GeoPoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A geo point must be an object.");
  }
  const point = value as Record<string, unknown>;
  if (typeof point.latitude !== "number" || !Number.isFinite(point.latitude)
    || point.latitude < -90 || point.latitude > 90) {
    throw new TypeError("Geo latitude must be between -90 and 90.");
  }
  if (typeof point.longitude !== "number" || !Number.isFinite(point.longitude)
    || point.longitude < -180 || point.longitude > 180) {
    throw new TypeError("Geo longitude must be between -180 and 180.");
  }
  if (point.altitude !== undefined && (typeof point.altitude !== "number" || !Number.isFinite(point.altitude))) {
    throw new TypeError("Geo altitude must be a finite number.");
  }
}

export function distanceInMeters(value: number, unit: DistanceUnit = "meters"): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Distance must be a non-negative number.");
  if (unit === "kilometers") return value * 1_000;
  if (unit === "miles") return value * 1_609.344;
  return value;
}

/** Great-circle distance using a mean Earth radius of 6,371,008.8 meters. */
export function haversineDistance(left: GeoPoint, right: GeoPoint): number {
  assertGeoPoint(left);
  assertGeoPoint(right);
  const radians = Math.PI / 180;
  const latitude = (right.latitude - left.latitude) * radians;
  const longitude = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitude / 2) ** 2
    + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians)
    * Math.sin(longitude / 2) ** 2;
  return 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GeoBoundingBox {
  northEast: GeoPoint;
  southWest: GeoPoint;
}

/** A conservative latitude/longitude box around a circular search radius. */
export function boundingBox(center: GeoPoint, radiusMeters: number): GeoBoundingBox {
  assertGeoPoint(center);
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new TypeError("Geo radius must be a non-negative number of meters.");
  }
  const latitudeDelta = radiusMeters / 111_320;
  const longitudeScale = Math.max(Math.cos(center.latitude * Math.PI / 180), 1e-12);
  const longitudeDelta = radiusMeters / (111_320 * longitudeScale);
  return {
    northEast: {
      latitude: Math.min(90, center.latitude + latitudeDelta),
      longitude: Math.min(180, center.longitude + longitudeDelta),
    },
    southWest: {
      latitude: Math.max(-90, center.latitude - latitudeDelta),
      longitude: Math.max(-180, center.longitude - longitudeDelta),
    },
  };
}
