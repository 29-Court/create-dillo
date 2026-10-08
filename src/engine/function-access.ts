import { HTTP_API_PREFIX } from "../versions.js";
import { ArmadilloFunctionError, type ArmadilloBackendDefinition, type ArmadilloFunctionContext, type JsonObject, type ArmadilloRecord } from '../backend.js';
import type { EngineEnvironment } from './environment.js';
import { route } from './routing.js';

/** Reuse REST authorization, schema validation, and registered-App ceilings. */
export function callerAccess(request: Request, env: EngineEnvironment, backend: ArmadilloBackendDefinition): Pick<ArmadilloFunctionContext, 'records' | 'files'> {
  async function call(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const url = new URL(request.url);
    url.pathname = path;
    url.search = '';
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    return route(new Request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, backend);
  }
  const segment = (value: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ArmadilloFunctionError(422, 'VALIDATION_ERROR', 'Invalid resource name or id.');
    return encodeURIComponent(value);
  };
  const tablePath = (table: string, id?: string) => `${HTTP_API_PREFIX}/tables/${segment(table)}${id ? '/' + segment(id) : ''}`;
  async function object(path: string, method = 'GET', data?: JsonObject): Promise<ArmadilloRecord> {
    const response = await call(path, method, data === undefined ? undefined : { data });
    return (await response.json() as { object: ArmadilloRecord }).object;
  }
  return {
    records: {
      get: (table, id) => object(tablePath(table, id)),
      create: (table, data) => object(tablePath(table), 'POST', data),
      update: (table, id, data) => object(tablePath(table, id), 'PATCH', data),
      delete: async (table, id) => { await call(tablePath(table, id), 'DELETE'); },
      query: async (table, query = {}) => (await (await call(`${HTTP_API_PREFIX}/query/${segment(table)}`, 'POST', query)).json() as { results: ArmadilloRecord[] }).results,
    },
    files: {
      get: async (id) => {
        const response = await call(`${HTTP_API_PREFIX}/files/${segment(id)}`);
        return { body: response.body!, size: Number(response.headers.get('content-length') ?? 0), etag: response.headers.get('etag') ?? '' };
      },
      delete: async (id) => { await call(`${HTTP_API_PREFIX}/files/${segment(id)}`, 'DELETE'); },
    },
  };
}
