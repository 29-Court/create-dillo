import { FieldDefinition } from "./schema.js";
class ComputedFieldDefinition extends FieldDefinition {
  constructor(config, compute) {
    super(config);
    this.compute = compute;
  }
  compute;
  optional() {
    throw new TypeError("Computed fields are always present on records and cannot be optional.");
  }
  default(_value) {
    throw new TypeError("Computed fields are derived and cannot have a stored default.");
  }
  min(_value) {
    throw new TypeError("Validate the inputs to a computed field instead of the derived value.");
  }
  max(_value) {
    throw new TypeError("Validate the inputs to a computed field instead of the derived value.");
  }
}
function define(type, compute) {
  if (typeof compute !== "function") throw new TypeError("A computed field needs a compute function.");
  return new ComputedFieldDefinition({
    type: "computed",
    required: true,
    computedType: type
  }, compute);
}
const computed = Object.freeze({
  string: (compute) => define("string", compute),
  integer: (compute) => define("integer", compute),
  boolean: (compute) => define("boolean", compute)
});
function evaluateComputedFields(fields, record) {
  const result = { ...record };
  for (const [name, field] of Object.entries(fields)) {
    if (field.config.type !== "computed") continue;
    const computedField = field;
    const value = computedField.compute(Object.freeze({ ...result }));
    const expected = field.config.computedType;
    if (expected === "integer" && !Number.isInteger(value) || expected === "string" && typeof value !== "string" || expected === "boolean" && typeof value !== "boolean") {
      throw new TypeError(`Computed field \`${name}\` returned the wrong value type.`);
    }
    result[name] = value;
  }
  return result;
}
export {
  ComputedFieldDefinition,
  computed,
  evaluateComputedFields
};
