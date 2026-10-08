import { Armadillo, defineFunction, string } from "create-dillo";
import schema from "./schema.ts";

export default Armadillo.backend({
  schema,
  functions: {
    greet: defineFunction()
      .input({ name: string().min(1) })
      .output({ message: string() })
      .handler((_context, input) => ({ message: `Hello ${input.name}` })),
  },
});
