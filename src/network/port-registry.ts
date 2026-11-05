/**
 * Which server owns which port.
 *
 * This is the contract between two halves of the runtime that never import each other: the `http`
 * shim, which decides that a `listen(port)` call should own a port, and the service-worker proxy,
 * which receives a real browser request for `/preview/<port>/` and has to find the handler that
 * answers it. Both need the same answer to the same question, so the answer lives here.
 *
 * Two families of prior art informed the shape rather than the code (see
 * docs/references/discovery-labor-openwebcontainer.md and discovery-stackblitz-public.md):
 *
 * 1. Keying by a composite of protocol and port is what both reference implementations do, and it is
 *    necessary rather than fussy: a browser treats `http://host:3000` and `https://host:3000` as
 *    different origins, so collapsing them would route a request to the wrong handler.
 * 2. Refusing a second server on a taken port mirrors a real socket bind. Node throws EADDRINUSE, so
 *    an application that relies on that error to detect a busy port must see the same failure here.
 *    Silently taking the port over would break that application in a way it cannot detect.
 *
 * Port 0 is deliberately NOT given "some free port" semantics here. Node treats it as "allocate an
 * ephemeral port and tell me which", which means the real port has to be reported back to the caller
 * through the server's `listening` callback. That reporting path does not exist yet, so inventing a
 * number now would produce a server that thinks it is on one port while the proxy looks for another.
 */

/** The protocols a preview server can speak. Both are modelled even though only http is routed yet. */
export type ServeProtocol = "http" | "https";

/** A composite key: the same number can be in use on two protocols because they are two origins. */
export type PortKey = `${ServeProtocol}:${number}`;

export interface PortBinding {
  readonly protocol: ServeProtocol;
  readonly port: number;
}

/** Raised when a port is already bound. Carries `code` so callers can branch on it like a socket error. */
export class PortInUseError extends Error {
  public readonly code = "EADDRINUSE";
  public readonly key: PortKey;

  constructor(key: PortKey, owner?: string) {
    const where = owner === undefined ? "" : ` (requested by ${owner})`;
    super(`listen EADDRINUSE: address already in use ${key.split(":")[0]} port ${key.split(":")[1]}${where}`);
    this.name = "PortInUseError";
    this.key = key;
  }
}

/** Raised for a port number that could never be bound. Separate from PortInUseError on purpose. */
export class InvalidPortError extends Error {
  public readonly code = "ERR_SOCKET_BAD_PORT";

  constructor(port: number) {
    super(
      port === 0
        ? "listen on port 0 is not supported yet: ephemeral port allocation requires reporting the assigned port back through the listening event"
        : `port must be an integer between 1 and 65535, got ${String(port)}`,
    );
    this.name = "InvalidPortError";
  }
}

export function portKey(protocol: ServeProtocol, port: number): PortKey {
  return `${protocol}:${port}`;
}

/** Deterministic order: protocol name, then port number. Never insertion order. */
function compareBindings(a: PortBinding, b: PortBinding): number {
  if (a.protocol !== b.protocol) return a.protocol < b.protocol ? -1 : 1;
  return a.port - b.port;
}

/**
 * The registry itself. Deliberately tiny and synchronous: it is read on the request path, and an async
 * lookup there would put a promise between an incoming request and the handler that answers it.
 */
export class PortRegistry {
  readonly #bindings = new Map<PortKey, PortBinding>();

  /** Bind a port, or throw. `owner` is only used in the error message to make a collision diagnosable. */
  bind(protocol: ServeProtocol, port: number, owner?: string): PortBinding {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidPortError(port);
    if (port === 0) throw new InvalidPortError(port);

    const key = portKey(protocol, port);
    const existing = this.#bindings.get(key);
    if (existing !== undefined) throw new PortInUseError(key, owner);
    const binding: PortBinding = { protocol, port };
    this.#bindings.set(key, binding);
    return binding;
  }

  /**
   * Release a port. Returns whether it was bound, because `server.close()` on a server that never
   * listened is a no-op in Node and must not become an error here.
   */
  release(protocol: ServeProtocol, port: number): boolean {
    return this.#bindings.delete(portKey(protocol, port));
  }

  has(protocol: ServeProtocol, port: number): boolean {
    return this.#bindings.has(portKey(protocol, port));
  }

  get(protocol: ServeProtocol, port: number): PortBinding | undefined {
    return this.#bindings.get(portKey(protocol, port));
  }

  /** Every binding, sorted deterministically so a preview list or a log line is stable across runs. */
  list(): readonly PortBinding[] {
    return [...this.#bindings.values()].sort(compareBindings);
  }

  /** Used by teardown: a runtime that is torn down must not leave a port looking busy. */
  clear(): readonly PortBinding[] {
    const previous = this.list();
    this.#bindings.clear();
    return previous;
  }
}
