/**
 * Applies the Vercel rollout plan. Executed, never imported.
 *
 * Dry run by default: printing the plan is free, so `--apply` is a deliberate second act. Without a token the dry run
 * still works, which is the point: the plan can be reviewed now and executed the moment access exists.
 *
 * Usage:
 *   npm run deploy:plan -- --project webcontainer --app app.example.dev --preview-base preview.example.dev
 *   npm run deploy:apply -- --project webcontainer --app app.example.dev --preview-base preview.example.dev
 */

import { assertCanApply, buildDeploymentPlan, renderPlan, type PlannedRequest } from "./vercel-plan.js";

const VERCEL_API = "https://api.vercel.com";

interface Args {
  readonly project: string;
  readonly appHost: string;
  readonly previewBase: string;
  readonly apply: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--dry-run") continue;
    if (arg !== undefined && arg.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      values.set(arg.slice(2), next);
      index += 1;
    }
  }
  const project = values.get("project") ?? "";
  const appHost = values.get("app") ?? "";
  const previewBase = values.get("preview-base") ?? "";
  const missing = [
    project === "" ? "--project" : "",
    appHost === "" ? "--app" : "",
    previewBase === "" ? "--preview-base" : "",
  ].filter((value) => value !== "");
  if (missing.length > 0) {
    throw new Error(
      `missing ${missing.join(", ")}. The domain is a product decision, not a default: name the editor hostname and ` +
        `the dedicated preview base explicitly.`,
    );
  }
  return { project, appHost, previewBase, apply };
}

function tokenOf(): string {
  return (process.env.VERCEL_TOKEN ?? "").trim();
}

function describePayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const record = payload as Record<string, unknown>;
  const error = record["error"];
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  const message = record["message"];
  return typeof message === "string" ? message : "";
}

async function call(request: PlannedRequest, token: string): Promise<unknown> {
  const response = await fetch(`${VERCEL_API}${request.path}`, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  const text = await response.text();
  const payload: unknown = text === "" ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const detail = describePayload(payload);
    throw new Error(`${request.method} ${request.path} -> ${response.status}${detail === "" ? "" : `: ${detail}`}`);
  }
  return payload;
}

/** Read back what the DNS/TLS state actually is, rather than assuming an attachment succeeded. */
function summariseDomains(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return ["  (no domain list returned)"];
  const domains = (payload as Record<string, unknown>)["domains"];
  if (!Array.isArray(domains)) return ["  (no domain list returned)"];
  return domains.map((entry) => {
    if (typeof entry !== "object" || entry === null) return "  (unreadable entry)";
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"] : "(unnamed)";
    const verified = record["verified"] === true ? "verified" : "NOT verified";
    const configured = record["configuredBy"] === undefined ? "" : ` via ${String(record["configuredBy"])}`;
    return `  ${name}: ${verified}${configured}`;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildDeploymentPlan(args.project, { appHost: args.appHost, previewBaseDomain: args.previewBase });

  console.log(renderPlan(plan));

  if (!args.apply) {
    console.log("\nDRY RUN. Nothing was sent. Re-run with --apply once VERCEL_TOKEN is set and the domain is approved.");
    return;
  }

  assertCanApply({ token: tokenOf(), apply: args.apply });
  const token = tokenOf();
  console.log("\nAPPLYING:");

  for (const request of plan.requests) {
    const payload = await call(request, token);
    console.log(`  ok ${request.method} ${request.path}`);
    if (request.path.endsWith("/domains") && request.method === "GET") {
      for (const line of summariseDomains(payload)) console.log(line);
    }
  }

  console.log(
    "\nNext: point the zone's nameservers at Vercel so the wildcard certificate can be issued, then run\n" +
      "  npm run verify:deployment -- --editor-url https://<app host> --preview-base <preview base>\n" +
      "Previews are not ready until that verifier passes against the live origins.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAILED: ${message}`);
  process.exitCode = 1;
});
