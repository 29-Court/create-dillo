import type { ArmadilloBackendDefinition } from './backend.js';

/** Explicit declarations, never guesses based on scanning application code. */
export function appCapabilities(backend: ArmadilloBackendDefinition = {}) {
  const files = backend.files !== false; // Preserve existing applications' file API.
  if (!files) {
    for (const table of Object.values(backend.schema?.normalized.tables ?? {})) {
      if (Object.values(table.fields).some(field => field.type === 'file')) {
        throw new TypeError('files: false conflicts with a schema file field. Enable files.');
      }
    }
    for (const extension of backend.extensions ?? []) {
      if (extension.requirements?.infrastructure?.some(item => item.kind === 'storage' && item.name === 'FILES')) {
        throw new TypeError(`files: false conflicts with extension ${extension.name}. Enable files.`);
      }
    }
  }
  return Object.freeze({ files, realtime: Boolean(backend.realtime) });
}
