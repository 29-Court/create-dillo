import { FieldDefinition, type NormalizedField } from "./schema.js";
export type ComputedValue = string | number | boolean;
export type ComputeFields = Readonly<Record<string, unknown>>;
/** A read-only field evaluated after a record is loaded and never persisted. */
export declare class ComputedFieldDefinition<TValue extends ComputedValue> extends FieldDefinition<TValue, true, true> {
    readonly compute: (fields: ComputeFields) => TValue;
    /** @internal Type-level marker used to exclude computeds from create input. */
    readonly __computed: true;
    constructor(config: NormalizedField, compute: (fields: ComputeFields) => TValue);
    optional(): never;
    default(_value: TValue): never;
    min(_value: number): never;
    max(_value: number): never;
}
/** Factories for schema-level, read-only virtual properties. */
export declare const computed: Readonly<{
    string: (compute: (fields: ComputeFields) => string) => ComputedFieldDefinition<string>;
    integer: (compute: (fields: ComputeFields) => number) => ComputedFieldDefinition<number>;
    boolean: (compute: (fields: ComputeFields) => boolean) => ComputedFieldDefinition<boolean>;
}>;
/** @internal Evaluate a table's computed fields without serializing functions. */
export declare function evaluateComputedFields(fields: Record<string, FieldDefinition<unknown, boolean, boolean>>, record: Record<string, unknown>): Record<string, unknown>;
