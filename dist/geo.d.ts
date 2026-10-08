import { FieldDefinition } from "./schema.js";
export type GeoPoint = {
    latitude: number;
    longitude: number;
    altitude?: number;
};
export type DistanceUnit = "meters" | "kilometers" | "miles";
export declare class GeoFieldDefinition<TRequired extends boolean = true, THasDefault extends boolean = false> extends FieldDefinition<GeoPoint, TRequired, THasDefault> {
    optional(): GeoFieldDefinition<false, THasDefault>;
    default(value: GeoPoint): GeoFieldDefinition<TRequired, true>;
    /** Create a composite latitude/longitude index for column-backed storage. */
    index(name?: string): GeoFieldDefinition<TRequired, THasDefault>;
    minAltitude(meters: number): GeoFieldDefinition<TRequired, THasDefault>;
    maxAltitude(meters: number): GeoFieldDefinition<TRequired, THasDefault>;
}
export declare function geo(): GeoFieldDefinition;
export declare function assertGeoPoint(value: unknown): asserts value is GeoPoint;
export declare function distanceInMeters(value: number, unit?: DistanceUnit): number;
/** Great-circle distance using a mean Earth radius of 6,371,008.8 meters. */
export declare function haversineDistance(left: GeoPoint, right: GeoPoint): number;
export interface GeoBoundingBox {
    northEast: GeoPoint;
    southWest: GeoPoint;
}
/** A conservative latitude/longitude box around a circular search radius. */
export declare function boundingBox(center: GeoPoint, radiusMeters: number): GeoBoundingBox;
