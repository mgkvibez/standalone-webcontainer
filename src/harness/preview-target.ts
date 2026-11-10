/**
 * Turn a fixture's assertion URL into the request the preview gateway understands.
 *
 * A fixture says `http://localhost:3000/`, because that is what a program's own documentation says and what the fixture's
 * intent describes. The gateway routes `/preview/<port>/<rest>`, because in the browser it answers requests for
 * `<app-origin>/preview/<port>/…` and refuses anything else outright. This is that translation, kept in one place rather than
 * duplicated in the harness, and kept pure so it can be tested without a runtime.
 *
 * A non-local host is refused rather than guessed at. Outbound HTTP is a different path with its own policy and its own refusal
 * records, and silently routing `http://example.com/` to a local port would report a fixture failure for the wrong reason.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class NotPreviewable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotPreviewable";
  }
}

export function previewRequestUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NotPreviewable(`not an absolute URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new NotPreviewable(`preview assertions must target a program on this machine, not ${parsed.hostname}`);
  }
  if (parsed.port === "") {
    throw new NotPreviewable(`a preview URL needs an explicit port, and ${url} has none`);
  }
  return `/preview/${parsed.port}${parsed.pathname === "" ? "/" : parsed.pathname}${parsed.search}`;
}
