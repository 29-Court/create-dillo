import * as Effect from 'effect/Effect';
import type * as Tracer from 'effect/Tracer';
import type { ArmadilloTelemetry, ArmadilloSpan } from '../backend.js';
import type { ArmadilloEnv } from './environment.js';

const execution = Symbol('armadillo-execution');
type Attributes = ArmadilloSpan['attributes'];
interface Execution {
  span?: Tracer.Span;
  attributes: Attributes;
  telemetry?: ArmadilloTelemetry;
}
type OperationEnv = ArmadilloEnv & { [execution]?: Execution };

/** Request-local context works on Workers without AsyncLocalStorage or globals. */
export function operationEnvironment(env: ArmadilloEnv, attributes: Attributes, telemetry?: ArmadilloTelemetry): ArmadilloEnv {
  return Object.assign(Object.create(env), {
    [execution]: { attributes: Object.freeze({ ...attributes }), ...(telemetry ? { telemetry } : {}) },
  });
}

/** Trace context of the nearest enclosing operation span, for joining logs to telemetry. */
export function currentTrace(env: ArmadilloEnv): { traceId: string; spanId: string } | undefined {
  const span = (env as OperationEnv)[execution]?.span;
  return span ? { traceId: span.traceId, spanId: span.spanId } : undefined;
}

/** Typed internal failure; the original value is restored at the Promise boundary. */
class OperationFailure {
  readonly _tag = 'OperationFailure';
  constructor(readonly original: unknown) {}
}

/**
 * The incremental Promise bridge. Effect owns span completion, including failure.
 * Explicit parents preserve context across Promise boundaries and concurrent calls.
 * No automatic retries: a Promise may already have committed a write.
 */
export async function operation<A>(
  env: ArmadilloEnv,
  name: string,
  attributes: Attributes,
  run: (env: ArmadilloEnv) => Promise<A>,
): Promise<A> {
  const parent = (env as OperationEnv)[execution];
  const combined = Object.freeze({ ...parent?.attributes, ...attributes });
  let completed: Tracer.Span | undefined;
  const program = Effect.useSpan(name, {
    ...(parent?.span ? { parent: parent.span } : {}),
    attributes: combined,
  }, span => {
    completed = span;
    const child = Object.assign(Object.create(env), {
      [execution]: { ...parent, attributes: combined, span },
    });
    return Effect.tryPromise({ try: () => run(child), catch: error => new OperationFailure(error) });
  });
  // Match outside useSpan so failures remain failures in Effect's completed span.
  const result = await Effect.runPromise(Effect.match(program, {
    onSuccess: value => ({ ok: true as const, value }),
    onFailure: error => ({ ok: false as const, error }),
  }));
  if (completed?.status._tag === 'Ended' && parent?.telemetry) {
    const record: ArmadilloSpan = Object.freeze({
      name, traceId: completed.traceId, spanId: completed.spanId,
      ...(parent.span ? { parentSpanId: parent.span.spanId } : {}),
      startedAt: new Date(Number(completed.status.startTime / 1_000_000n)).toISOString(),
      durationMs: Number(completed.status.endTime - completed.status.startTime) / 1_000_000,
      status: result.ok ? 'ok' : 'error', attributes: combined,
    });
    try {
      // Sinks enqueue synchronously; their network/resource lifecycle belongs to the host.
      // Also contain accidental async rejection without delaying application responses.
      void Promise.resolve(parent.telemetry.span(record)).catch(() => {});
    } catch { /* Diagnostic telemetry cannot change a committed operation's result. */ }
  }
  if (!result.ok) throw result.error.original;
  return result.value;
}
