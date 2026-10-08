function appCapabilities(backend = {}) {
  const files = backend.files !== false;
  if (!files) {
    for (const table of Object.values(backend.schema?.normalized.tables ?? {})) {
      if (Object.values(table.fields).some((field) => field.type === "file")) {
        throw new TypeError("files: false conflicts with a schema file field. Enable files.");
      }
    }
    for (const extension of backend.extensions ?? []) {
      if (extension.requirements?.infrastructure?.some((item) => item.kind === "storage" && item.name === "FILES")) {
        throw new TypeError(`files: false conflicts with extension ${extension.name}. Enable files.`);
      }
    }
  }
  return Object.freeze({ files, realtime: Boolean(backend.realtime) });
}
export {
  appCapabilities
};
