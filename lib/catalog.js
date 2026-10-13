// What the explainer knows for certain, taken from Claude's public docs (checked October 13, 2026).
// Claude may only link to pages in DOCS, so every link in an answer is one a person checked.

export const DOCS = [
  { url: 'https://platform.claude.com/docs/en/api/errors#http-errors', title: 'API errors: HTTP error codes' },
  { url: 'https://platform.claude.com/docs/en/api/errors#request-id', title: 'API errors: request IDs' },
  { url: 'https://platform.claude.com/docs/en/api/errors#request-size-limits', title: 'API errors: request size limits' },
  { url: 'https://platform.claude.com/docs/en/api/errors#long-requests', title: 'API errors: long requests' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#rate-limits', title: 'Rate limits' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#response-headers', title: 'Rate limits: response headers' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#reaching-your-spend-cap', title: 'Rate limits: reaching your spend cap' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#setting-your-own-spend-limit', title: 'Rate limits: setting your own spend limit' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#requesting-higher-limits', title: 'Rate limits: requesting higher limits' },
  { url: 'https://platform.claude.com/docs/en/api/rate-limits#message-batches-api', title: 'Rate limits: Message Batches API' },
  { url: 'https://platform.claude.com/docs/en/api/service-tiers', title: 'Service tiers' },
  { url: 'https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage', title: 'How do I pay for my Claude API usage?' },
  { url: 'https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code', title: 'Manage API key environment variables in Claude Code' },
  { url: 'https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan', title: 'Use Claude Code with your Pro or Max plan' },
  { url: 'https://support.claude.com/en/articles/12466728-troubleshoot-claude-error-messages', title: 'Troubleshoot Claude error messages' },
  { url: 'https://status.claude.com', title: 'Claude status page' },
];

// Summarized from platform.claude.com/docs/en/api/errors and /rate-limits.
export const FACTS = `
HTTP errors returned by the Claude API:
- 400 invalid_request_error: a problem with the format or content of the request. Also returned when usage reaches an organization or workspace spend limit the customer set (except the Claude Code workspace, which can return 429).
- 401 authentication_error: a problem with the API key (malformed, revoked, or expired).
- 402 billing_error: a problem with billing or payment information. Check payment details in the Claude Console.
- 403 permission_error: the API key doesn't have permission for the resource. Check organization access and workspace settings.
- 404 not_found_error: the requested resource wasn't found. Check the endpoint path and resource IDs.
- 409 conflict_error: the request conflicts with the current state of a resource.
- 413 request_too_large: the request exceeds the maximum number of bytes for that endpoint.
- 429 rate_limit_error: the organization hit a rate limit, reached its usage tier's monthly spend cap, or hit a spend limit on the Claude Code workspace. A sharp increase in usage can also trigger 429s from acceleration limits, so ramp traffic up gradually.
- 500 api_error: an unexpected internal error. Retry with exponential backoff. If it persists, contact support with the request ID.
- 504 timeout_error: the request timed out while processing. Use streaming for long-running requests.
- 529 overloaded_error: the API is temporarily overloaded because of high traffic across all users. Not caused by the customer. Retry with backoff.

Rate limits and spend caps:
- A normal rate-limit 429 includes a retry-after header (seconds to wait). Earlier retries fail.
- The anthropic-ratelimit-* response headers show the limit, remaining requests and tokens, and reset times.
- Spend cap 429: when an organization reaches its usage tier's monthly spend cap, requests return 429 rate_limit_error with error.details.error_code = "enforced_spend_limit_reached" and NO retry-after header. Retrying, including SDK automatic retries, keeps failing until access resumes (00:00 UTC on the first day of the next month) or the organization moves to a higher tier.
- Customers can set their own spend limit below the tier cap in Console > Settings > Billing.
- Usage tiers increase as an organization's spend grows; customers can request higher limits.
- For most current models, only uncached input tokens count toward input-tokens-per-minute limits, so prompt caching raises effective throughput.

Other:
- Every response includes a request-id header (for example req_018EeWyXxfu5pfWkrYcMdjWG); error bodies repeat it as request_id. Ask for it when escalating.
- The official SDKs retry transient failures automatically.
- Claude Code: if ANTHROPIC_API_KEY is set in the environment, Claude Code uses that key and bills the API instead of a Pro or Max plan. Run /status to see which method is active; unset the variable and /login to use the plan.
- Purchased API credits are prepaid and apply to API usage. A "credit balance is too low" error means the organization or workspace the key belongs to has no usable credit.
- Incidents are posted on status.claude.com.
`.trim();

const STATUS_TYPES = {
  400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error',
  404: 'not_found_error', 409: 'conflict_error', 413: 'request_too_large', 429: 'rate_limit_error',
  500: 'api_error', 504: 'timeout_error', 529: 'overloaded_error',
};
const TYPE_STATUS = Object.fromEntries(Object.entries(STATUS_TYPES).map(([s, t]) => [t, Number(s)]));

// Pull the hard facts out of whatever was pasted, before Claude sees it.
// These are shown on the page as "what the request says", separate from Claude's reading of it.
export function parse(text) {
  const found = {};
  const type = text.match(/\b(invalid_request_error|authentication_error|billing_error|permission_error|not_found_error|conflict_error|request_too_large|rate_limit_error|api_error|timeout_error|overloaded_error)\b/);
  if (type) found.error_type = type[1];

  // Prefer an explicit status line or field; only fall back to a bare number when it sits next to error words,
  // so "$500 in credits" isn't read as a 500.
  const codes = '(400|401|402|403|404|409|413|429|500|504|529)';
  const status =
    text.match(new RegExp(`(?:HTTP\\/[\\d.]+\\s+|status(?:[ _]?code)?["']?\\s*[:=]?\\s*)${codes}\\b`, 'i')) ||
    (found.error_type ? null : text.match(new RegExp(`\\b${codes}\\b(?=[^\\n]{0,40}(?:error|overloaded|too many|rate|limit|timeout|unauthori[sz]ed|forbidden))`, 'i')));
  if (status) found.http_status = Number(status[1]);
  if (!found.http_status && found.error_type) found.http_status = TYPE_STATUS[found.error_type];
  if (!found.error_type && found.http_status) found.error_type = STATUS_TYPES[found.http_status];

  const reqId = text.match(/\breq_[A-Za-z0-9]{10,}\b/);
  if (reqId) found.request_id = reqId[0];

  const retry = text.match(/retry-after["']?\s*[:=]\s*["']?(\d+)/i);
  if (retry) found.retry_after_seconds = Number(retry[1]);

  const code = text.match(/error_code["']?\s*[:=]\s*["']([a-z_]+)["']/i);
  if (code) found.error_code = code[1];

  const msg = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.){1,300})"/);
  if (msg) found.message = msg[1].replace(/\\"/g, '"');

  const headers = [...text.matchAll(/(anthropic-ratelimit-[a-z-]+)["']?\s*[:=]\s*["']?([^\s"',]+)/gi)].map((m) => `${m[1].toLowerCase()}: ${m[2]}`);
  if (headers.length) found.ratelimit_headers = headers.slice(0, 12);

  found.spend_cap = found.error_code === 'enforced_spend_limit_reached';
  return found;
}

// Never send a pasted API key to Claude or keep it anywhere.
export function redact(text) {
  let count = 0;
  const clean = text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, () => (count++, 'sk-ant-[REDACTED]'))
    .replace(/(x-api-key|authorization)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9_\-.]{12,}/gi, (_, h, sep) => (count++, `${h}${sep}[REDACTED]`));
  return { text: clean, redactions: count };
}
