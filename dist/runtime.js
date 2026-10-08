import { createRuntimeEnvironment } from "./engine/runtime.js";
import { handleRequest } from "./engine/engine.js";
import { runScheduledSweep } from "./engine/maintenance.js";
import { consumeMailQueue } from "./engine/mail-queue.js";
function createRuntime(options) {
  const environment = createRuntimeEnvironment(options);
  return Object.freeze({
    resources: environment.resources,
    fetch: (request) => handleRequest(request, environment, options.backend),
    scheduled: () => runScheduledSweep(environment, options.backend),
    queue: (batch) => consumeMailQueue(batch, environment)
  });
}
export {
  createRuntime
};
