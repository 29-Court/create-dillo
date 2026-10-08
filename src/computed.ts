import { FieldDefinition, type NormalizedField } from "./schema.js";

export type ComputedValue = string | number | boolean;
export type ComputeFields = Readonly<Record<string, unknown>>;

/** A read-only field evaluated after a record is loaded and never persisted. */
export class ComputedFieldDefinition<TValue extends ComputedValue>
  extends FieldDefinition<TValue, true, true> {
  /** @internal Type-level marker used to exclude computeds from create input. */
  declare readonly __computed: true;

  constructor(
    config: NormalizedField,
    readonly compute: (fields: ComputeFields) => TValue,
  ) {
    super(config);
  }

  override optional(): never {
    throw new TypeError("Computed fields are always present on records and cannot be optional.");
  }

  override default(_value: TValue): never {
    throw new TypeError("Computed fields are derived and cannot have a stored default.");
  }

  override min(_value: number): never {
    throw new TypeError("Validate the inputs to a computed field instead of the derived value.");
  }

  override max(_value: number): never {
    throw new TypeError("Validate the inputs to a computed field instead of the derived value.");
  }
}

function define<TValue extends ComputedValue>(
  type: "string" | "integer" | "boolean",
  compute: (fields: ComputeFields) => TValue,
): ComputedFieldDefinition<TValue> {
  if (typeof compute !== "function") throw new TypeError("A computed field needs a compute function.");
  return new ComputedFieldDefinition({
    type: "computed",
    required: true,
    computedType: type,
  }, compute);
}

/** Factories for schema-level, read-only virtual properties. */
export const computed = Object.freeze({
  string: (compute: (fields: ComputeFields) => string) => define("string", compute),
  integer: (compute: (fields: ComputeFields) => number) => define("integer", compute),
  boolean: (compute: (fields: ComputeFields) => boolean) => define("boolean", compute),
});

/** @internal Evaluate a table's computed fields without serializing functions. */
export function evaluateComputedFields(
  fields: Record<string, FieldDefinition<unknown, boolean, boolean>>,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...record };
  for (const [name, field] of Object.entries(fields)) {
    if (field.config.type !== "computed") continue;
    const computedField = field as ComputedFieldDefinition<ComputedValue>;
    const value = computedField.compute(Object.freeze({ ...result }));
    const expected = field.config.computedType;
    if ((expected === "integer" && !Number.isInteger(value))
      || (expected === "string" && typeof value !== "string")
      || (expected === "boolean" && typeof value !== "boolean")) {
      throw new TypeError(`Computed field \`${name}\` returned the wrong value type.`);
    }
    result[name] = value;
  }
  return result;
}
