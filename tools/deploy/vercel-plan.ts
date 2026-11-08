/**
 * Planning for the Vercel rollout, kept pure and offline.
 *
 * Everything here is a decision or a string; nothing performs network I/O. That split exists so the plan can be
 * reviewed, printed and unit-tested without a token, and so `--apply` has exactly one code path to execute.
 *
 * The rules encode what the deployment actually requires:
 *  - `VITE_PREVIEW_BASE_DOMAIN` must be set in BOTH environments, because a preview deployment is built from the
 *    Preview environment and a production build must not silently lose the ability to launch previews.
 *  - The wildcard that serves `<previewId>.<base>` is `*.<base>`, and wildcard TLS is only issued through Vercel's
 *    nameservers, so the app host and the preview base must live in the same DNS zone: one nameserver move has to
 *    cover both, and a split would need two.
 *  - The app host must not sit under the preview wildcard. If it did, the same hostname would resolve to both the
 *    editor and a project preview, and the origin separation the preview design depends on would be gone.
 */

export const PREVIEW_ENV_NAME = "VITE_PREVIEW_BASE_DOMAIN";

const PLACEHOLDER_ZONES = ["example.com", "example.org", "example.net", "example.edu"];
const RESERVED_SUFFIXES = [".localhost", ".test", ".invalid", ".local"];

/** Two-part public suffixes we refuse to mis-split. Not exhaustive; it exists to stop the common mistake. */
const TWO_PART_SUFFIXES = [
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "co.nz", "co.za", "com.ng", "co.ke", "com.br", "co.in",
];

export interface DomainDecision {
  /** Editor hostname, e.g. `app.example.dev` or the apex. */
  readonly appHost: string;
  /** Dedicated preview base, e.g. `preview.example.dev`. Project previews become `<previewId>.<base>`. */
  readonly previewBaseDomain: string;
}

export interface DeploymentTargets extends DomainDecision {
  /** The wildcard hostname that must be attached for `<previewId>.<base>` to resolve. */
  readonly wildcardHost: string;
  /** Registrable zone both hostnames belong to; this is the zone whose nameservers must move. */
  readonly zone: string;
}

export interface PlannedRequest {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: unknown;
  /** Why this request exists, shown in the dry run so the plan is reviewable without reading this file. */
  readonly why: string;
}

export interface DeploymentPlan {
  readonly project: string;
  readonly targets: DeploymentTargets;
  readonly requests: readonly PlannedRequest[];
}

function labelsOf(host: string): string[] {
  return host.split(".");
}

/** Approximate registrable zone. Deliberately small: it only needs to stop the obvious mis-splitting. */
export function zoneOf(host: string): string {
  const labels = labelsOf(host);
  if (labels.length < 2) throw new Error(`"${host}" is not a DNS name`);
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.includes(lastTwo)) {
    if (labels.length < 3) throw new Error(`"${host}" needs a name in front of "${lastTwo}"`);
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function assertDnsName(value: string, label: string): string {
  const host = value.trim().toLowerCase();
  if (host === "") throw new Error(`${label} is empty`);
  if (host.includes("://") || host.includes("/") || host.includes(":") || host.includes("@")) {
    throw new Error(`${label} must be a bare hostname, without a scheme, port or path: got "${value}"`);
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new Error(`${label} is not a valid DNS name: got "${value}"`);
  }
  return host;
}

/**
 * Reject anything that cannot be a real deployment target. Placeholders are refused by name rather than by
 * convention, because `preview.example.com` in `env.preview.example` is exactly what a copy-paste reaches for.
 */
export function assertUsableHost(value: string, label: string): string {
  const trimmed = value.trim().toLowerCase();
  // Reserved names are named before the shape check: a bare "localhost" fails both tests, and the useful message is
  // "that is a local name", not "that is not a DNS name".
  if (trimmed === "localhost" || RESERVED_SUFFIXES.some((suffix) => trimmed.endsWith(suffix))) {
    throw new Error(`${label} "${trimmed}" is a local or reserved name; production needs a real DNS name`);
  }
  const host = assertDnsName(value, label);
  if (PLACEHOLDER_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`))) {
    throw new Error(`${label} "${host}" is a placeholder; choose the real domain before planning a rollout`);
  }
  return host;
}

/**
 * Turn two reviewed hostnames into the full deployment target, refusing combinations that cannot work.
 * Order matters: shape, then placeholders, then the relationships between the two names.
 */
export function resolveTargets(decision: DomainDecision): DeploymentTargets {
  const appHost = assertUsableHost(decision.appHost, "app host");
  const previewBaseDomain = assertUsableHost(decision.previewBaseDomain, "preview base domain");

  if (appHost === previewBaseDomain) {
    throw new Error("the app host and the preview base domain must differ; previews need their own origin");
  }

  const zone = zoneOf(appHost);
  const previewZone = zoneOf(previewBaseDomain);
  if (zone !== previewZone) {
    throw new Error(
      `both hostnames must be in the same zone so one nameserver move covers them: "${appHost}" is in ${zone}, ` +
        `"${previewBaseDomain}" is in ${previewZone}`,
    );
  }

  if (previewBaseDomain === zone) {
    throw new Error(
      `the preview base must be a subdomain of ${zone}, not the zone itself: a wildcard on the apex would compete ` +
        `with the editor hostname`,
    );
  }

  if (appHost === previewBaseDomain || appHost.endsWith(`.${previewBaseDomain}`)) {
    throw new Error(
      `the app host "${appHost}" falls under the preview wildcard "*.${previewBaseDomain}", so one hostname would be ` +
        `both the editor and a preview; move the editor hostname out of that subtree`,
    );
  }

  return { appHost, previewBaseDomain, wildcardHost: `*.${previewBaseDomain}`, zone };
}

/** Domain attachment is two calls: the editor hostname, then the wildcard that serves every preview origin. */
export function domainAttachments(targets: DeploymentTargets): string[] {
  return [targets.appHost, targets.wildcardHost];
}

/**
 * The ordered requests `--apply` performs. Reading state comes first so an apply is never blind, and the env
 * variables come before the domains so the first deployment on a preview origin is built with previews enabled.
 */
export function buildDeploymentPlan(project: string, decision: DomainDecision): DeploymentPlan {
  const name = project.trim();
  if (name === "") throw new Error("a Vercel project name or id is required");
  const targets = resolveTargets(decision);
  const encoded = encodeURIComponent(name);

  const requests: PlannedRequest[] = [
    {
      method: "GET",
      path: `/v9/projects/${encoded}`,
      why: "inspect the existing project: framework, build settings and current domains, before changing anything",
    },
    {
      method: "POST",
      path: `/v10/projects/${encoded}/env?upsert=true`,
      body: { key: PREVIEW_ENV_NAME, value: targets.previewBaseDomain, type: "plain", target: ["production", "preview"] },
      why: "one value in both environments: the preview build refuses to run without it, the production build bakes it in",
    },
    ...domainAttachments(targets).map((domain) => ({
      method: "POST" as const,
      path: `/v10/projects/${encoded}/domains`,
      body: { name: domain },
      why:
        domain === targets.appHost
          ? "attach the editor hostname"
          : `attach the wildcard that serves every preview origin (\`<previewId>.${targets.previewBaseDomain}\`)`,
    })),
    {
      method: "GET",
      path: `/v10/projects/${encoded}/domains`,
      why: "read back verification and TLS state; a wildcard is not live until its nameservers are Vercel's",
    },
  ];

  return { project: name, targets, requests };
}

export interface ApplyPreconditions {
  readonly token: string | null | undefined;
  readonly apply: boolean;
}

/**
 * `--apply` needs a token; a dry run does not. The token is never part of the plan, so a printed plan is safe to
 * paste into a report.
 */
export function assertCanApply(preconditions: ApplyPreconditions): void {
  if (!preconditions.apply) return;
  const token = (preconditions.token ?? "").trim();
  if (token === "") {
    throw new Error(
      "Vercel access is required to apply this plan: set VERCEL_TOKEN (project and domain scope) or connect Vercel " +
        "to the agent. No changes have been made.",
    );
  }
}

/** Human-readable dry run. Contains no secrets and no side effects. */
export function renderPlan(plan: DeploymentPlan): string {
  const lines: string[] = [
    `project:      ${plan.project}`,
    `editor host:  ${plan.targets.appHost}`,
    `preview base: ${plan.targets.previewBaseDomain}  ->  previews at <previewId>.${plan.targets.previewBaseDomain}`,
    `wildcard:     ${plan.targets.wildcardHost}`,
    `dns zone:     ${plan.targets.zone}  (nameservers must be Vercel's for wildcard TLS)`,
    "",
    "requests, in order:",
  ];
  plan.requests.forEach((request, index) => {
    lines.push(`  ${index + 1}. ${request.method} ${request.path}`);
    lines.push(`     why: ${request.why}`);
    if (request.body !== undefined) lines.push(`     body: ${JSON.stringify(request.body)}`);
  });
  return lines.join("\n");
}
