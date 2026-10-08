import { Armadillo } from "create-dillo/client";
import type backend from "./backend.ts";
import schema from "./schema.ts";

const app = Armadillo({ url: "http://localhost:8787", schema });
const api = Armadillo.client<typeof backend>({ url: "http://localhost:8787" });

export async function validCalls() {
  const project = await app.tables.Project.create({ name: "Garden" });
  const name: string = project.name;
  const active: boolean = project.active;
  const result: { message: string } = await api.functions.greet({ name });
  return { name, active, result };
}

// Compile-only negative fixtures. These functions are never executed.
export function invalidCalls() {
  // @ts-expect-error A required schema field cannot be omitted.
  void app.tables.Project.create({});
  // @ts-expect-error Schema field types reach the installed client declarations.
  void app.tables.Project.create({ name: 123 });
  // @ts-expect-error Unknown tables are not part of the schema.
  void app.tables.Missing.query();
  // @ts-expect-error Function input is inferred from a type-only backend import.
  void api.functions.greet({ name: 123 });
  // @ts-expect-error Required function inputs cannot be omitted.
  void api.functions.greet();
  // @ts-expect-error Unknown functions are not part of the backend.
  void api.functions.missing({});
}
