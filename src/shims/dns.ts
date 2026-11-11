/**
 * `dns`: a resolver for the names this runtime can actually answer, and an honest refusal for the rest.
 *
 * The module exists because Node has it and because vite imports it at module scope in three files (`import 'node:dns'`), so a missing builtin
 * stops a boot before any lookup happens. What it cannot do is resolve arbitrary names: there is no resolver to consult from a browser sandbox,
 * and inventing an answer would be worse than refusing. Two names are answered because they are facts about this runtime rather than lookups:
 * an IP literal is already an address, and `localhost` is this machine.
 *
 * The refusal is a typed `ENOSYS`, the same code `fs.watch` uses when its substrate has no watcher. It is deliberately NOT added to the ADR-0014
 * closed set: that set is for capabilities the runtime declines with evidence a fixture asserts on, and a failed name lookup is an ordinary
 * runtime error a program handles, not a capability classification.
 */

/** Node's `dns.lookup` result. */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

interface LookupOptions {
  readonly family?: number;
  readonly all?: boolean;
  readonly verbatim?: boolean;
}

const noResolver = (hostname: string): Error =>
  Object.assign(
    new Error(
      `getaddrinfo ENOSYS ${hostname}: this runtime has no DNS resolver, so only IP literals and localhost can be looked up. ` +
        "Network access goes through the runtime's gateway, which addresses hosts by name.",
    ),
    { code: "ENOSYS", errno: -38, syscall: "getaddrinfo", hostname },
  );

/** The addresses this runtime can answer without a resolver, in the order Node's hosts-file lookup would return them. */
function knownAddresses(hostname: string): LookupAddress[] | null {
  if (hostname === "localhost") return [{ address: "127.0.0.1", family: 4 }];
  // A literal is not resolved, it is parsed: Node returns it unchanged and reports its family.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return [{ address: hostname, family: 4 }];
  if (/^[0-9a-f:]+$/i.test(hostname) && hostname.includes(":")) return [{ address: hostname, family: 6 }];
  return null;
}

function normalize(options?: number | LookupOptions | ((...args: never[]) => void)): LookupOptions {
  if (typeof options === "function") return {};
  if (typeof options === "number") return { family: options };
  return options ?? {};
}

export function lookup(
  hostname: string,
  optionsOrCallback?: number | LookupOptions | ((...args: never[]) => void),
  maybeCallback?: (...args: never[]) => void,
): void {
  const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as
    | ((error: Error | null, address: LookupAddress | LookupAddress[], family?: number) => void)
    | undefined;
  const options = normalize(optionsOrCallback);
  const mem = /^\[(.+)\]$/.exec(hostname);
  const name = mem?.[1] ?? hostname;
  if (callback === undefined) throw noResolver(name);
  const found = knownAddresses(name);
  if (found === null) {
    // Asynchronously, as Node does: a synchronous throw from the callback form would be caught as a programmer error rather than handled.
    queueMicrotask(() => callback(noResolver(name), { address: "", family: 0 }));
    return;
  }
  const wanted = options.family === undefined || options.family === 0 ? found : found.filter((entry) => entry.family === options.family);
  if (wanted.length === 0) {
    queueMicrotask(() => callback(noResolver(name), wanted));
    return;
  }
  queueMicrotask(() =>
    options.all === true ? callback(null, wanted) : callback(null, wanted[0] as LookupAddress, wanted[0]?.family),
  );
}

const lookupPromise = (hostname: string, options?: number | LookupOptions): Promise<LookupAddress | LookupAddress[]> =>
  new Promise((resolve, reject) => {
    const opts = normalize(options);
    lookup(hostname, opts, ((error: Error | null, address: LookupAddress | LookupAddress[]) => {
      if (error !== null) reject(error);
      else resolve(opts.all === true ? address : (address as LookupAddress));
    }) as (...args: never[]) => void);
  });

const refuseLookupService = (): never => {
  throw Object.assign(new Error("lookupService is not available in this runtime: there is no DNS resolver"), {
    code: "ENOSYS",
    syscall: "getnameinfo",
  });
};

export const promises = {
  lookup: lookupPromise,
  lookupService: async (): Promise<never> => refuseLookupService(),
};

export function lookupService(): never {
  return refuseLookupService();
}

export function resolve(): never {
  return refuseLookupService();
}

export const resolve4 = resolve;
export const resolve6 = resolve;
export const resolveAny = resolve;
export const resolveCname = resolve;
export const resolveMx = resolve;
export const resolveTxt = resolve;
export const resolveSrv = resolve;
export const resolveNs = resolve;

/** Node's default result order. This runtime has one address per name, so the setting has nothing to reorder. */
export function getDefaultResultOrder(): string {
  return "verbatim";
}

export function setDefaultResultOrder(): void {
  // Accepted and ignored, on purpose: a program that sets this is describing a preference, not a capability, and refusing would break a boot over
  // an ordering that cannot matter here.
}

/** Node's `dns.Resolver`. There is no resolver to construct, so construction refuses rather than yielding an object whose every method throws. */
export class Resolver {
  constructor() {
    refuseLookupService();
  }
}

export default {
  lookup,
  lookupService,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCname,
  resolveMx,
  resolveTxt,
  resolveSrv,
  resolveNs,
  getDefaultResultOrder,
  setDefaultResultOrder,
  promises,
  Resolver,
};
