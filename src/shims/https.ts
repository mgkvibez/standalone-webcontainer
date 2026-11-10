/**
 * `https`, which exists in the module graph but cannot do its job here.
 *
 * Packages import it at load time (`express` does), so the module must be importable. But `https.createServer` means TLS, and this
 * runtime has no TLS stack; returning a plaintext server from it would silently downgrade a program's security posture. So the
 * import works, the server types are the same objects as `http`'s, and `createServer` refuses by name.
 */

import { IncomingMessage, Server, ServerResponse, createServer as createHttpServer, type RequestListener } from "./http.js";

const refuse = (): never => {
  const error = new Error(
    "ERR_NOT_SUPPORTED: https.createServer is not available in this runtime: there is no TLS stack, and serving plaintext from it would silently downgrade the program",
  ) as Error & { code: string };
  error.code = "ERR_NOT_SUPPORTED";
  throw error;
};

export const createServer = (_options?: unknown, _requestListener?: RequestListener): Server => refuse();

export const request = (): never => refuse();
export const get = (): never => refuse();

export { Server, IncomingMessage, ServerResponse, createHttpServer };

export default { createServer, request, get, Server, IncomingMessage, ServerResponse, createHttpServer };
