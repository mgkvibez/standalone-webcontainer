/**
 * `dns`: what this runtime can answer about names, and what it refuses.
 *
 * The line this pins is the honest one. `localhost` and an IP literal are facts this runtime knows without asking anybody, and a browser sandbox
 * has no resolver for anything else, so the refusal names the gap instead of inventing an address.
 */

import { describe, expect, it } from "vitest";

import dns, { lookup } from "../../src/shims/dns.js";

const lookupAsync = (hostname: string, options?: Parameters<typeof lookup>[1]) =>
  new Promise<{ error: unknown; address: unknown; family: unknown }>((resolve) => {
    lookup(hostname, options, ((error: unknown, address: unknown, family: unknown) => {
      resolve({ error, address, family });
    }) as never);
  });

describe("dns", () => {
  it("answers localhost, which is a fact about this runtime", async () => {
    // The exact call vite makes at boot: `promises.lookup("localhost")`.
    await expect(dns.promises.lookup("localhost")).resolves.toEqual({ address: "127.0.0.1", family: 4 });
  });

  it("returns an IP literal unchanged, and reports its family", async () => {
    await expect(dns.promises.lookup("10.1.2.3")).resolves.toEqual({ address: "10.1.2.3", family: 4 });
    await expect(dns.promises.lookup("::1")).resolves.toEqual({ address: "::1", family: 6 });
  });

  it("refuses a name it cannot resolve, with a code a program can branch on", async () => {
    const { error } = await lookupAsync("example.com");

    expect(error).toMatchObject({ code: "ENOSYS", syscall: "getaddrinfo", hostname: "example.com" });
    // The message must not read as "that name does not exist": the runtime has no resolver, which is a different fact.
    expect((error as Error).message).toContain("has no DNS resolver");
  });

  it("rejects the promise form rather than resolving with an empty address", async () => {
    await expect(dns.promises.lookup("example.com")).rejects.toMatchObject({ code: "ENOSYS" });
  });

  it("returns every known address when all is set, as Node does", async () => {
    await expect(dns.promises.lookup("localhost", { all: true })).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
  });
});
