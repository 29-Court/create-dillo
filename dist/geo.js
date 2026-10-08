import { FieldDefinition } from "./schema.js";
class GeoFieldDefinition extends FieldDefinition {
  optional() {
    return new GeoFieldDefinition({ ...this.config, required: false });
  }
  default(value) {
    assertGeoPoint(value);
    return new GeoFieldDefinition({ ...this.config, default: value });
  }
  /** Create a composite latitude/longitude index for column-backed storage. */
  index(name = "location") {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) {
      throw new TypeError("Geo index names must begin with a letter and use letters, numbers, or underscores.");
    }
    return new GeoFieldDefinition({ ...this.config, geoIndex: name });
  }
  minAltitude(meters) {
    if (!Number.isFinite(meters)) throw new TypeError("Minimum altitude must be finite.");
    if (this.config.maxAltitude !== void 0 && meters > this.config.maxAltitude) {
      throw new TypeError("Minimum altitude cannot exceed maximum altitude.");
    }
    return new GeoFieldDefinition({ ...this.config, minAltitude: meters });
  }
  maxAltitude(meters) {
    if (!Number.isFinite(meters)) throw new TypeError("Maximum altitude must be finite.");
    if (this.config.minAltitude !== void 0 && meters < this.config.minAltitude) {
      throw new TypeError("Maximum altitude cannot be below minimum altitude.");
    }
    return new GeoFieldDefinition({ ...this.config, maxAltitude: meters });
  }
}
function geo() {
  return new GeoFieldDefinition({ type: "geo", required: true });
}
function assertGeoPoint(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A geo point must be an object.");
  }
  const point = value;
  if (typeof point.latitude !== "number" || !Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    throw new TypeError("Geo latitude must be between -90 and 90.");
  }
  if (typeof point.longitude !== "number" || !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    throw new TypeError("Geo longitude must be between -180 and 180.");
  }
  if (point.altitude !== void 0 && (typeof point.altitude !== "number" || !Number.isFinite(point.altitude))) {
    throw new TypeError("Geo altitude must be a finite number.");
  }
}
function distanceInMeters(value, unit = "meters") {
  if (!Number.isFinite(value) || value < 0) throw new TypeError("Distance must be a non-negative number.");
  if (unit === "kilometers") return value * 1e3;
  if (unit === "miles") return value * 1609.344;
  return value;
}
function haversineDistance(left, right) {
  assertGeoPoint(left);
  assertGeoPoint(right);
  const radians = Math.PI / 180;
  const latitude = (right.latitude - left.latitude) * radians;
  const longitude = (right.longitude - left.longitude) * radians;
  const a = Math.sin(latitude / 2) ** 2 + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitude / 2) ** 2;
  return 63710088e-1 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function boundingBox(center, radiusMeters) {
  assertGeoPoint(center);
  if (!Number.isFinite(radiusMeters) || radiusMeters < 0) {
    throw new TypeError("Geo radius must be a non-negative number of meters.");
  }
  const latitudeDelta = radiusMeters / 111320;
  const longitudeScale = Math.max(Math.cos(center.latitude * Math.PI / 180), 1e-12);
  const longitudeDelta = radiusMeters / (111320 * longitudeScale);
  return {
    northEast: {
      latitude: Math.min(90, center.latitude + latitudeDelta),
      longitude: Math.min(180, center.longitude + longitudeDelta)
    },
    southWest: {
      latitude: Math.max(-90, center.latitude - latitudeDelta),
      longitude: Math.max(-180, center.longitude - longitudeDelta)
    }
  };
}
export {
  GeoFieldDefinition,
  assertGeoPoint,
  boundingBox,
  distanceInMeters,
  geo,
  haversineDistance
};
