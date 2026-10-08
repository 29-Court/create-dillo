import * as Effect from "effect/Effect";
const execution = /* @__PURE__ */ Symbol("armadillo-execution");
function operationEnvironment(env, attributes, telemetry) {
  return Object.assign(Object.create(env), {
    [execution]: { attributes: Object.freeze({ ...attributes }), ...telemetry ? { telemetry } : {} }
  });
}
function currentTrace(env) {
  const span = env[execution]?.span;
  return span ? { traceId: span.traceId, spanId: span.spanId } : void 0;
}
class OperationFailure {
  constructor(original) {
    this.original = original;
  }
  original;
  _tag = "OperationFailure";
}
async function operation(env, name, attributes, run) {
  const parent = env[execution];
  const combined = Object.freeze({ ...parent?.attributes, ...attributes });
  let completed;
  const program = Effect.useSpan(name, {
    ...parent?.span ? { parent: parent.span } : {},
    attributes: combined
  }, (span) => {
    completed = span;
    const child = Object.assign(Object.create(env), {
      [execution]: { ...parent, attributes: combined, span }
    });
    return Effect.tryPromise({ try: () => run(child), catch: (error) => new OperationFailure(error) });
  });
  const result = await Effect.runPromise(Effect.match(program, {
    onSuccess: (value) => ({ ok: true, value }),
    onFailure: (error) => ({ ok: false, error })
  }));
  if (completed?.status._tag === "Ended" && parent?.telemetry) {
    const record = Object.freeze({
      name,
      traceId: completed.traceId,
      spanId: completed.spanId,
      ...parent.span ? { parentSpanId: parent.span.spanId } : {},
      startedAt: new Date(Number(completed.status.startTime / 1000000n)).toISOString(),
      durationMs: Number(completed.status.endTime - completed.status.startTime) / 1e6,
      status: result.ok ? "ok" : "error",
      attributes: combined
    });
    try {
      void Promise.resolve(parent.telemetry.span(record)).catch(() => {
      });
    } catch {
    }
  }
  if (!result.ok) throw result.error.original;
  return result.value;
}
export {
  currentTrace,
  operation,
  operationEnvironment
};
