/**
 * `tls`: the module exists, and a hand-made TLS socket is refused.
 *
 * This runtime does have TLS, but not at this layer: requests leave through the gateway, which terminates TLS outside the sandbox. There is no raw
 * socket here to attach a TLS session to, and no certificate store to verify one against, so `connect` refuses instead of returning a socket that
 * never opens. A dependency that wants HTTPS should use `https`/`fetch`, which do work; the message says so, because that is the actionable half.
 *
 * The bundled client vite ships imports this at module scope (`import * as tls from 'node:tls'`) and only calls `connect` when a plugin makes an
 * HTTPS request, so the import must succeed.
 */

const unavailable = (member: string): never => {
  throw Object.assign(
    new Error(
      `tls.${member} is not available in this runtime: TLS is terminated by the gateway rather than by a socket in the sandbox. ` +
        "Use https or fetch, which go through it.",
    ),
    { code: "ENOSYS", syscall: member },
  );
};

export function connect(): never {
  return unavailable("connect");
}

export function createServer(): never {
  return unavailable("createServer");
}

export class TLSSocket {
  constructor() {
    unavailable("TLSSocket");
  }
}

export class SecureContext {
  constructor() {
    unavailable("SecureContext");
  }
}

/** Conservative defaults rather than a fabricated policy: a caller that reads these gets the standard port and the modern floor. */
export const DEFAULT_MIN_VERSION = "TLSv1.2";
export const DEFAULT_MAX_VERSION = "TLSv1.3";

export default { connect, createServer, TLSSocket, SecureContext, DEFAULT_MIN_VERSION, DEFAULT_MAX_VERSION };
