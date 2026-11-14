/**
 * Reads the isolation headers from the one place the browser already declares them: the resolved Vite config.
 *
 * Deriving rather than restating is the whole point. The dev server, the preview server and `vercel.json` all have to
 * agree on `same-origin` / `require-corp` / `cross-origin`, and `tests/unit/isolation.headers.test.ts` pins that pair.
 * Cloudflare Pages introduces a third carrier for the same three values, and a third copy typed in by hand is a copy
 * that drifts. So the Pages file is rendered from this, and `npm run headers:check` fails when the committed file and
 * the resolved config disagree.
 *
 * The config is imported through `vite.config.js` and called, exactly as the isolation test does, so this reads the real
 * resolved values rather than grepping the source text. That import is the reason this module is async and lives apart
 * from `pages-headers.ts`, which stays pure so the contract logic can be tested without a build.
 */

import { ISOLATION_HEADER_NAMES, type IsolationValues } from "./pages-headers.js";

interface ResolvedConfig {
  readonly server?: { readonly headers?: Record<string, string> };
  readonly preview?: { readonly headers?: Record<string, string> };
}

/** Case-insensitive lookup, because a header name's case is not what the browser matches on. */
function valueOf(headers: Record<string, string>, name: string, where: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (entry === undefined) {
    throw new Error(`vite.config.ts no longer declares ${name} in ${where}, so there is no verified value to deploy`);
  }
  return String(entry[1]);
}

/**
 * The three isolated-document header values, as the browser build would send them.
 *
 * The dev and preview blocks are required to agree here rather than trusted to: the preview server is what someone
 * checks a production build against locally, so a value that only exists in one block has not been verified anywhere.
 */
export async function resolveIsolationValues(): Promise<IsolationValues> {
  // Dynamic import, not `require`: the config is an ES module. Reading it this way means the values come from the
  // resolved config the build actually uses, not from a second copy of the same literals in a tool.
  const loaded = (await import("../../vite.config.js")) as unknown as {
    default: (env: { command: string; mode: string }) => ResolvedConfig;
  };
  const config = loaded.default({ command: "serve", mode: "development" });
  const server = config.server?.headers ?? {};
  const preview = config.preview?.headers ?? {};

  const result: IsolationValues = {
    opener: valueOf(server, ISOLATION_HEADER_NAMES.opener, "server.headers"),
    embedder: valueOf(server, ISOLATION_HEADER_NAMES.embedder, "server.headers"),
    resource: valueOf(server, ISOLATION_HEADER_NAMES.resource, "server.headers"),
  };

  const previewResult: IsolationValues = {
    opener: valueOf(preview, ISOLATION_HEADER_NAMES.opener, "preview.headers"),
    embedder: valueOf(preview, ISOLATION_HEADER_NAMES.embedder, "preview.headers"),
    resource: valueOf(preview, ISOLATION_HEADER_NAMES.resource, "preview.headers"),
  };

  if (
    previewResult.opener !== result.opener ||
    previewResult.embedder !== result.embedder ||
    previewResult.resource !== result.resource
  ) {
    throw new Error(
      `vite.config.ts declares different isolation headers for dev (${JSON.stringify(result)}) and preview ` +
        `(${JSON.stringify(previewResult)}); the deployed value cannot be derived until one of them is wrong`,
    );
  }

  return result;
}
