import { boolean, owner, schema, string, table } from "create-dillo/schema";

// Private to the person who created the row.
export default schema({
  Project: table({
    name: string().min(1).max(120),
    active: boolean().default(true),
  }).permissions({
    view: owner,
    edit: owner,
  }),
});
