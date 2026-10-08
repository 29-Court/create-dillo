import { operation, operationEnvironment } from "./operation.js";
import {} from "./environment.js";
import {} from "../backend.js";
import {} from "./environment.js";
import { AUTH_PROVIDER } from "./environment.js";
import { customAuthProvider } from "../requirements.js";
import { finish } from "./http.js";
import { route } from "./routing.js";
import { errorResponse } from "./http.js";
async function handleRequest(request, env, options = {}) {
  const provider = customAuthProvider(options.auth);
  const runtimeEnv = provider ? Object.assign(Object.create(env), { [AUTH_PROVIDER]: provider }) : env;
  const requestId = crypto.randomUUID();
  try {
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    request = new Request(request, { headers });
    const executionEnv = operationEnvironment(runtimeEnv, { requestId, method: request.method }, options.telemetry);
    return finish(await operation(executionEnv, "request", {}, (scoped) => route(request, scoped, options)), request, runtimeEnv, requestId);
  } catch (error) {
    return finish(errorResponse(error, requestId), request, runtimeEnv, requestId);
  }
}
export {
  handleRequest
};
