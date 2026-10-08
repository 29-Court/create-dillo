const middlewareDatabases = /* @__PURE__ */ new WeakMap();
function setMiddlewareDatabase(context, resolve) {
  middlewareDatabases.set(context, resolve);
}
function middlewareDatabase(context) {
  const internal = middlewareDatabases.get(context);
  if (internal) return internal();
  return context.db;
}
export {
  middlewareDatabase,
  setMiddlewareDatabase
};
