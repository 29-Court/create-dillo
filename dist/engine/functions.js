import { currentTrace, operation } from "./operation.js";
import { requestMagicLink } from "./sessions.js";
import { callerAccess } from "./function-access.js";
import { readTrustedFile, trustedGroups, trustedRecords } from "./trusted-records.js";
import {} from "./environment.js";
import {} from "../backend.js";
import { HttpError } from "./http.js";
import { validName } from "./apps.js";
import { requireAuth } from "./auth.js";
import { membershipsFor } from "./teams.js";
import { readJson } from "./validation.js";
import { validateFunctionInput } from "../backend.js";
import { validateFunctionData } from "./validation.js";
import { requiredSecrets } from "../backend.js";
import { resolveExtensionEnvironment } from "../extensions.js";
import { ArmadilloFunctionError } from "../backend.js";
import {} from "../backend.js";
import {} from "../backend.js";
import {} from "../backend.js";
import { createUserForAdministration, renameUser } from "./auth.js";
import { resetUserPassword } from "./auth.js";
import { emitEvent, deferRealtime } from "./events.js";
import {} from "../backend.js";
import { composeMiddleware } from "../backend.js";
import { setMiddlewareDatabase } from "./middleware/database.js";
import { validateFunctionOutput } from "../backend.js";
import { json } from "./http.js";
import { chargeUsage } from "./usage.js";
const TRANSACTION_TIMEOUT_MS = 3e4;
async function functionRoute(request, env, currentAppId, name, options) {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(name, "Function name");
  if (!options.functions?.[name]) throw new HttpError(404, "NOT_FOUND", "Function not found.");
  return operation(
    env,
    `functions.${name}`,
    { appId: currentAppId, functionName: name },
    (scoped) => executeFunction(request, scoped, currentAppId, name, options)
  );
}
async function executeFunction(request, env, currentAppId, name, options) {
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND", "Route not found.");
  validName(name, "Function name");
  const definition = options.functions?.[name];
  if (!definition) throw new HttpError(404, "NOT_FOUND", "Function not found.");
  const auth = await operation(env, "auth.verify", {}, (scoped2) => requireAuth(request, scoped2, currentAppId, `functions:${name}`));
  const identity = { principalId: auth.principal.id, principalType: auth.principal.type };
  const groups = await membershipsFor(env, currentAppId, auth.user.id);
  await operation(env, "policy.function", { ...identity, action: "invoke" }, async () => {
    if (definition.authorize) {
      const membership = groups.find((group) => group.groupSlug === definition.authorize?.group);
      if (!membership || !membership.trusted || definition.authorize.roles && !definition.authorize.roles.includes(membership.role)) {
        throw new HttpError(403, "FORBIDDEN", "Your group role does not allow this function.");
      }
    }
  });
  const body = await readJson(request, env);
  const data = await validateFunctionInput(definition, validateFunctionData(body.data ?? {}, env).data);
  const runtimeValues = env;
  const rawSecrets = {};
  for (const requirement of requiredSecrets(options)) {
    const value = runtimeValues[requirement.name];
    if (requirement.required && (typeof value !== "string" || !value.trim())) {
      throw new HttpError(
        500,
        "INTERNAL_ERROR",
        `Missing application secret: ${requirement.name}. Configure it in this deployment's runtime environment.`
      );
    }
  }
  for (const [key, declaration] of Object.entries(options.secrets ?? {})) {
    const value = runtimeValues[declaration.name ?? key];
    if (typeof value === "string" && value.trim()) rawSecrets[key] = value;
  }
  const extensionEnv = await resolveExtensionEnvironment(options.extensions, {
    appId: currentAppId,
    request,
    // Redacted by `resolveExtensionEnvironment`: never the live environment, and
    // never the caller's credentials on `request`.
    runtime: runtimeValues
  });
  for (const key of Object.keys(rawSecrets)) {
    if (Object.hasOwn(extensionEnv, key)) {
      throw new ArmadilloFunctionError(500, "INTERNAL_ERROR", `Secret and extension both provide env.${key}.`);
    }
  }
  const database = env.DB;
  const nativeTransaction = definition.transaction ? database.transaction : void 0;
  if (definition.transaction && !nativeTransaction) {
    throw new ArmadilloFunctionError(
      501,
      "INTERNAL_ERROR",
      "This adapter does not support function transactions. Use db.batch() for atomic statements, or an adapter with native transactions."
    );
  }
  let functionEnv = env;
  const logger = {
    write(event) {
      const requestId = event.requestId ?? request.headers.get("x-request-id") ?? void 0;
      const trace = currentTrace(functionEnv);
      const traceId = event.traceId ?? trace?.traceId;
      const spanId = event.spanId ?? trace?.spanId;
      const enriched = {
        timestamp: event.timestamp || (/* @__PURE__ */ new Date()).toISOString(),
        level: event.level,
        event: event.event,
        appId: event.appId ?? currentAppId,
        stage: event.stage ?? (env.ARMADILLO_STAGE?.trim() || "unknown"),
        ...requestId ? { requestId } : {},
        ...traceId ? { traceId } : {},
        ...spanId ? { spanId } : {},
        functionName: event.functionName ?? name,
        actorId: event.actorId ?? auth.user.id,
        ...event.attributes ? { attributes: event.attributes } : {}
      };
      if (options.logger) return options.logger.write(enriched);
      console.log(JSON.stringify(enriched));
    }
  };
  const scoped = callerAccess(request, env, options);
  const assertTrusted = () => {
    if (definition.authority !== "trusted") throw new ArmadilloFunctionError(403, "FORBIDDEN", "Raw capabilities require authority: trusted. Use records and files for caller-scoped access.");
  };
  const context = {
    appId: currentAppId,
    stage: env.ARMADILLO_STAGE?.trim() || "unknown",
    functionName: name,
    data,
    principal: auth.principal,
    user: { id: auth.user.id, email: auth.user.email, name: auth.user.name },
    groups,
    request,
    env: Object.freeze({ ...rawSecrets, ...extensionEnv }),
    records: scoped.records,
    get trusted() {
      assertTrusted();
      return {
        db: functionEnv.DB,
        files: functionEnv.FILES,
        get users() {
          return context.users;
        },
        records: trustedRecords(functionEnv, currentAppId, options, () => context.user.id),
        groups: trustedGroups(functionEnv, currentAppId),
        readFile: (id, fileOptions) => readTrustedFile(functionEnv, currentAppId, id, fileOptions)
      };
    },
    get db() {
      assertTrusted();
      return functionEnv.DB;
    },
    files: scoped.files,
    get users() {
      assertTrusted();
      return auth.external ? {
        create: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "External authentication manages users.");
        },
        requestMagicLink: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "External authentication manages sign-in emails.");
        },
        resetPassword: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "External authentication manages passwords.");
        },
        rename: () => {
          throw new ArmadilloFunctionError(403, "FORBIDDEN", "External authentication manages profile names.");
        }
      } : {
        create: (input) => createUserForAdministration(functionEnv, currentAppId, input),
        requestMagicLink: async (input) => {
          const headers = new Headers(request.headers);
          headers.delete("content-length");
          headers.set("content-type", "application/json");
          const response = await requestMagicLink(new Request(request.url, {
            method: "POST",
            headers,
            body: JSON.stringify(input)
          }), functionEnv, currentAppId, options.schema);
          return response.json();
        },
        resetPassword: (userId, newPassword) => resetUserPassword(
          functionEnv,
          currentAppId,
          userId,
          newPassword
        ),
        rename: (name2) => renameUser(functionEnv, currentAppId, context.user.id, name2)
      };
    },
    emit: (type, eventData, groupId) => emitEvent(
      functionEnv,
      currentAppId,
      auth.user.id,
      groupId,
      type,
      eventData,
      options
    ),
    logger,
    log: (message, details = {}) => {
      void logger.write({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        level: "info",
        event: message,
        attributes: details
      });
    },
    get trace() {
      return currentTrace(functionEnv) ?? { traceId: "unknown", spanId: "unknown" };
    },
    span: (name2, run2, attributes = {}) => {
      if (typeof name2 !== "string" || !name2.trim() || name2.length > 128) {
        throw new TypeError("Span names must be a non-empty string up to 128 characters.");
      }
      for (const value of Object.values(attributes ?? {})) {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new TypeError("Span attributes must be strings, numbers, or booleans.");
        }
      }
      return operation(functionEnv, name2, attributes ?? {}, async () => run2());
    }
  };
  setMiddlewareDatabase(context, () => functionEnv.DB);
  await chargeUsage(env, currentAppId, options, "function_calls");
  let result;
  const run = composeMiddleware(
    [...options.middleware ?? [], ...definition.middleware ?? []],
    async () => {
      result = await validateFunctionOutput(definition, await definition.handler(context, data));
    }
  );
  if (nativeTransaction) {
    let deferred;
    let transactionTimer;
    try {
      await nativeTransaction.call(database, async (transactionDatabase) => {
        const transactionEnv = Object.assign(Object.create(env), { DB: transactionDatabase });
        functionEnv = transactionEnv;
        deferred = deferRealtime(transactionEnv);
        const scopedTransaction = callerAccess(request, transactionEnv, options);
        context.records = scopedTransaction.records;
        context.files = scopedTransaction.files;
        await Promise.race([
          operation(functionEnv, "functions.handler", identity, async (handlerEnv) => {
            functionEnv = handlerEnv;
            await run(context);
          }),
          new Promise((_resolve, reject) => {
            transactionTimer = setTimeout(() => reject(new ArmadilloFunctionError(
              504,
              "INTERNAL_ERROR",
              `This transactional function exceeded ${TRANSACTION_TIMEOUT_MS}ms and was rolled back.`
            )), TRANSACTION_TIMEOUT_MS);
          })
        ]);
      });
      await deferred?.flush();
    } finally {
      if (transactionTimer) clearTimeout(transactionTimer);
      deferred?.discard();
    }
  } else {
    await operation(functionEnv, "functions.handler", identity, async (handlerEnv) => {
      functionEnv = handlerEnv;
      await run(context);
    });
  }
  return json({ result: result ?? null });
}
export {
  functionRoute
};
