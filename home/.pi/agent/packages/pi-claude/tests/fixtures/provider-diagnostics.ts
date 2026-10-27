import type { SDKAssistantMessageError } from "@anthropic-ai/claude-agent-sdk";

// Exhaustive against the installed SDK contract. Only these fixed categories,
// never upstream error text, may cross the diagnostic reporting boundary.
export const SDK_ERROR_CATEGORIES = Object.freeze({
  authentication_failed: "sdk-authentication-failed",
  oauth_org_not_allowed: "sdk-organization-not-allowed",
  account_on_hold: "sdk-account-on-hold",
  verification_required: "sdk-verification-required",
  billing_error: "sdk-billing-error",
  rate_limit: "sdk-rate-limit",
  overloaded: "sdk-overloaded",
  invalid_request: "sdk-invalid-request",
  model_not_found: "sdk-model-not-found",
  server_error: "sdk-server-error",
  unknown: "sdk-unknown",
  max_output_tokens: "sdk-max-output-tokens",
  cloud_credential_error: "sdk-cloud-credential-error",
} satisfies Record<SDKAssistantMessageError, string>);

// Public service explanation observed after explicitly authorized error inspection.
// Auth-route corroboration does not establish entitlement to third-party usage.
export const THIRD_PARTY_EXTRA_USAGE_NOTICE =
  "Third-party apps now draw from extra usage, not plan limits.";

/** Fixed keyword-presence hints only; never release source text or matched values. */
export function failureHints({ message }: { message: string | undefined }) {
  const lower = message?.toLowerCase() ?? "";
  return {
    model: lower.includes("model"),
    tokens: lower.includes("token"),
    thinking: lower.includes("thinking"),
    effort: lower.includes("effort"),
    unsupported: lower.includes("unsupported") || lower.includes("not supported"),
    notFound: lower.includes("not found") || lower.includes("not_found"),
    invalid: lower.includes("invalid"),
    permission: lower.includes("permission"),
    policy: lower.includes("policy"),
    billing: lower.includes("billing"),
    quota: lower.includes("quota") || lower.includes("usage limit"),
    thirdPartyExtraUsage: lower.includes(THIRD_PARTY_EXTRA_USAGE_NOTICE.toLowerCase()),
    network: lower.includes("connection") || lower.includes("network"),
    timeout: lower.includes("timeout") || lower.includes("timed out"),
    executable: lower.includes("executable") || lower.includes("enoent"),
    api: lower.includes("api"),
    request: lower.includes("request"),
    response: lower.includes("response"),
    message: lower.includes("message"),
    stream: lower.includes("stream"),
    tool: lower.includes("tool"),
    context: lower.includes("context"),
    beta: lower.includes("beta"),
    feature: lower.includes("feature"),
    internal: lower.includes("internal"),
    badRequest: lower.includes("bad request"),
    notAllowed: lower.includes("not allowed"),
    detailPresent: lower.startsWith("pi-claude: claude unknown: "),
    prompt: lower.includes("prompt"),
    content: lower.includes("content"),
    blocked: lower.includes("block"),
    security: lower.includes("security") || lower.includes("safety"),
    filter: lower.includes("filter"),
    organization: lower.includes("organization"),
    credential: lower.includes("credential") || lower.includes("oauth"),
    authorized: lower.includes("authoriz"),
    signature: lower.includes("signature"),
    malformed: lower.includes("malformed"),
    length: lower.includes("length") || lower.includes("too long"),
    client: lower.includes("client"),
    parse: lower.includes("pars"),
    json: lower.includes("json"),
    encoding: lower.includes("encod") || lower.includes("compress"),
    header: lower.includes("header"),
    bytes: lower.includes("byte"),
    http400: /\b400\b/.test(lower),
    http401: /\b401\b/.test(lower),
    http403: /\b403\b/.test(lower),
    http404: /\b404\b/.test(lower),
    http429: /\b429\b/.test(lower),
    http500: /\b500\b/.test(lower),
    http503: /\b503\b/.test(lower),
  };
}

/** Categories only: never return a raw SDK/CLI error to a diagnostic reporter. */
export function failureCategory({ message }: { message: string | undefined }) {
  if (!message) return null;
  if (
    message.startsWith(
      `pi-claude: Claude unknown: API Error: 400 ${THIRD_PARTY_EXTRA_USAGE_NOTICE}`,
    )
  )
    return "third-party-extra-usage-required";
  for (const [kind, category] of Object.entries(SDK_ERROR_CATEGORIES)) {
    const prefix = `pi-claude: Claude ${kind}`;
    if (message === prefix || message.startsWith(`${prefix}: `)) return category;
  }
  for (const [fragment, category] of [
    ["invalid SDK session initialization", "initialization-identity"],
    ["unexpected native tool, plugin, skill or MCP surface", "initialization-isolation"],
    ["unsupported SDK event", "unsupported-sdk-event"],
    ["Claude error_", "sdk-error-result"],
    ["Claude quota exceeded", "quota-rejected"],
    ["schema mismatch", "schema-mismatch"],
    ["timed out", "timeout"],
    ["MCP", "mcp-protocol"],
  ]) {
    if (message.includes(fragment)) return category;
  }
  return "unclassified";
}
