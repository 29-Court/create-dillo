import { defineBackend, defineFunction, string } from 'create-dillo';
import schema from './schema.ts';

export default defineBackend({
  schema,
  functions: {
    greet: defineFunction().input({ name: string().min(1) }).output({ message: string() })
      .handler((_context, { name }) => ({ message: `Hello, ${name}! Your projects are private to you.` })),
  },
});
