/**
 * `net`, which in a browser can answer questions but cannot open a socket.
 *
 * `net.isIP` and friends are pure functions over a string and are implemented properly, because packages branch on them to validate
 * a Host header. Sockets are refused by name: a browser page cannot open a raw TCP connection, so a `Socket` that reported itself
 * connected would be a lie the program would build on.
 */

import { EventEmitter } from "./events.js";

const refuse = (feature: string): Error => {
  const error = new Error(`ERR_NOT_SUPPORTED: net.${feature} is not available in this runtime: a browser cannot open a raw TCP connection`) as Error & {
    code: string;
  };
  error.code = "ERR_NOT_SUPPORTED";
  return error;
};

export function isIPv4(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const parts = input.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isIPv6(input: unknown): boolean {
  if (typeof input !== "string") return false;
  if (!input.includes(":")) return false;
  const sections = input.split("::");
  if (sections.length > 2) return false;
  const valid = (part: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(part);
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const tail = groups(sections[1] ?? "");
  // A trailing dotted-quad (::ffff:127.0.0.1) is legal IPv6 and is checked as IPv4.
  const lastGroup = tail.at(-1);
  const tailIsV4 = lastGroup !== undefined && lastGroup.includes(".") ? isIPv4(lastGroup) : false;
  const tailGroups = tailIsV4 ? tail.slice(0, -1) : tail;
  if (!tailGroups.every(valid)) return false;
  const head = groups(sections[0] ?? "");
  const headGroups = head.at(-1)?.includes(".") === true ? head.slice(0, -1) : head;
  if (!headGroups.every(valid)) return false;
  if (sections.length === 1) {
    const total = headGroups.length + (head.length > headGroups.length ? 1 : 0);
    return total === 8;
  }
  return true;
}

export function isIP(input: unknown): 0 | 4 | 6 {
  if (isIPv4(input)) return 4;
  if (isIPv6(input)) return 6;
  return 0;
}

export class Socket extends EventEmitter {
  readonly remoteAddress: string | undefined = undefined;
  readonly remotePort: number | undefined = undefined;
  readonly localAddress: string | undefined = "127.0.0.1";
  readonly localPort: number | undefined = undefined;
  readonly destroyed = false;
  readonly connecting = false;
  readonly readable = false;
  readonly writable = false;

  connect(): never {
    throw refuse("Socket.connect");
  }

  write(): never {
    throw refuse("Socket.write");
  }

  end(): never {
    throw refuse("Socket.end");
  }

  destroy(): void {
    return undefined;
  }

  setTimeout(): this {
    return this;
  }
}

export function createServer(): never {
  throw refuse("createServer");
}

export function createConnection(): never {
  throw refuse("createConnection");
}

export const connect = createConnection;

export function isIPv4Host(): false {
  return false;
}

export const constants = { SOCKET_TIMEOUT: 0 };

export default { isIP, isIPv4, isIPv6, Socket, createServer, createConnection, connect, constants };
