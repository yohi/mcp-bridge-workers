# OpenCode vs MCP Bridge: Atlassian Rovo MCP v2 OAuth / DCR static comparison

Assessment date: **2026-10-20 (JST)**.
Status: **SOURCE_LEVEL_COMPARISON_COMPLETE / CAUSAL_DIAGNOSIS_NOT_PROVEN / NO_LIVE_DCR_EXECUTED**.

## Evidence and limits

- OpenCode source (pinned commit `db45c950a94e2b4224ba134dfe9d0f3c52ecb7db`):
  - [OAuth provider configuration and login handling](https://github.com/anomalyco/opencode/blob/db45c950a94e2b4224ba134dfe9d0f3c52ecb7db/packages/core/src/mcp/oauth.ts)
  - [OAuth mock tests including DCR and saved-client reuse](https://github.com/anomalyco/opencode/blob/db45c950a94e2b4224ba134dfe9d0f3c52ecb7db/packages/core/test/mcp-oauth.test.ts)
- Bridge source on the PR #2 branch (compared at `47ebb6fba141171757cedb00581a261c7f79b5f7`):
  - `tools/local-oauth/check-localhost-redirect.mjs`, `tools/local-oauth/registration-result.mjs`, `tools/local-oauth/probe-core.mjs`.
- Operator-provided **redacted** authorization URLs show a working OpenCode login with a broad scope set and `prompt=consent`, versus Bridge with Bitbucket Read only and no `prompt` at the time of failure. Bridge subsequently added `prompt=consent` as an **untested hypothesis**.
- This is a comparison of **OpenCode's metadata supplied to the MCP SDK**, not a packet capture of its actual HTTP DCR POST. SDK serialization/defaults can affect the network request. The operator's installed OpenCode version was not supplied, so the pinned current code might differ from the installed binary.
- The actual returned client registration response for either application is not available. We cannot assert that the same return fields, registered grants, or authentication method were supplied by Atlassian.

## DCR request metadata / intended registration configuration

| Key | OpenCode source (MCP SDK provider metadata) | Bridge explicit DCR JSON | Assessment |
| --- | --- | --- | --- |
| `client_name` | `opencode` | `mcp-bridge-workers v2 localhost feasibility probe` | Cosmetic/application identity; client names may differ. |
| `client_uri` | `https://opencode.ai` | omitted | **Difference**; optional under RFC 7591. No proof it causes consent rejection. Do not impersonate OpenCode. |
| `redirect_uris` | one configured/dynamically chosen loopback callback | one dynamically chosen `http://127.0.0.1:<port>/callback` | Different paths and ports are valid if exact DCR/authorize redirect matches. |
| `grant_types` | `authorization_code`, `refresh_token` | `authorization_code` | **Material difference**; may influence refresh support, but no evidence of consent failure. The Bridge has no token/refresh implementation yet. |
| `response_types` | `code` | `code` | Same. |
| `token_endpoint_auth_method` | `none` unless a statically configured client secret triggers `client_secret_post` | `none` | Both generally public client + PKCE. |
| `scope` | included if an OAuth scope was explicitly configured | `read:bitbucket:agent-interface` | **Difference**. Without an explicit scope, OpenCode lets the MCP SDK/server challenge choose defaults at authorization time. |
| registration endpoint | discovered by MCP SDK from authorization-server metadata | issuer-scoped `https://auth.atlassian.com/<issuer-id>/dcr/register` discovered from v2 metadata | Do not confuse old `mcp.atlassian.com/v1/register` with v2 Identity. |

## Authorization URL: observed by operator

| Element | OpenCode | Bridge (when the failure was observed) | Finding |
| --- | --- | --- | --- |
| Endpoint | `https://auth.atlassian.com/authorize` | same | Match |
| `response_type=code` / PKCE S256 | yes | yes | Match |
| `resource` | `https://mcp.atlassian.com/v2/mcp` | same | Match |
| `redirect_uri` | loopback `/mcp/oauth/callback` | loopback `/callback` | Different but expected for distinct clients |
| `scope` | read/write/search and many other product scopes, plus `read:me`, `read:account`, `offline_access` | only `read:bitbucket:agent-interface` | Substantially different. **Do not copy OpenCode's Write/Delete/Manage privileges.** |
| `prompt` | `consent` | absent at failure; added in Bridge commit `47ebb6f` | One-variable hypothesis; no post-change live evidence. |
| `client_id` | unique app identifier | separate DCR-registered identifier | Different IDs are expected; values are not needed for source-level comparison. |

Note: current pinned OpenCode source does **not hardcode** `prompt=consent` in the OAuth provider; its tests include a flow that does not force it. The observed `prompt=consent` may be produced by the installed version, SDK behavior, or configuration. No universal requirement for `prompt=consent` is established.

## Client registration response: actual bytes unavailable

| Aspect | OpenCode | Bridge | Verification |
| --- | --- | --- | --- |
| Returned `client_id` | Passed from MCP SDK registration into authorization; can be stored as part of credential metadata | Required nonempty, consumed directly in authorize URL | Source-level handling only, not cross-app server responses |
| Returned `redirect_uris` | MCP SDK handles the registration response; OpenCode's mock test accepts a simulated response with `redirect_uris: []` | Requires an array containing the **exact** loopback URI | Bridge is stricter; an HTTP 2xx alone is not proof its validator accepted the response. |
| Returned `token_endpoint_auth_method` | MCP SDK handles response | Requires literal `none` | Bridge's fail-closed check, not yet evidenced against captured server response |
| Returned `client_secret` | SDK client metadata / saved credential handling; exact DCR response unknown | Ignores/discards unexpected `client_secret` **only when** method is `none` | Do not display/log/persist any secret |
| Client reuse | Source tries to reuse previously registered client bound to stored credentials; test verifies reuse | Intentionally ephemeral; every authorized probe run registers again | Different `client_id` between OpenCode terminals does **not** prove DCR always happens on every login. |
| Issuer binding | SDK checks discovery and may invalidate old registrations when issuer changes | Pinning via v2 PRM discovery, no client persistence | Different storage behavior |

## Differential diagnosis: not yet proven

1. **Highest-priority offline check:** ensure the user's OpenCode build matches this pinned version and verify the metadata OpenCode actually submits, especially `grant_types`, `client_uri`, `scope` and `token_endpoint_auth_method`. Avoid logging raw registration responses.
2. **First controlled compatibility candidate:** `prompt=consent` was added to the Bridge authorize URL **without additional scopes**. A live retest is not yet performed; the existence of similar independent `invalid_request` reports does not establish its cause.
3. **Second candidate:** DCR differences (`refresh_token` in grants, presence of `client_uri`, DCR scope strategy). Each would require a separate isolated modification and **new approved registration** to test; do not combine changes or broaden permissions.
4. **Remote behavior:** an independently reported Rovo MCP v2 DCR flow also failed after consent in October 2026. The service could have an upstream issue, but do not conclude this from a matching error alone: [Atlassian developer report](https://community.developer.atlassian.com/t/rovo-mcp-oauth-returns-invalid-request-after-consent-reproduced-with-independent-python-mcp-sdk-client/103197).

## Controlled next steps / security guardrails

- **No DCR POST, OAuth login, token request, secret collection or Worker deployment was performed for this comparison.**
- Do not rerun `npm run probe:atlassian-localhost` just to investigate existing runs: it registers a new client every time.
- Prefer further offline comparison, or ask Atlassian privately to correlate the prior error reference ID and timestamp. Never put raw `client_id`, `client_secret`, `code`, `state`, `code_challenge` or raw auth URLs in a public PR.
- If the owner explicitly authorizes a later single live retry, test **one variable at a time**, use only Bitbucket Read, and require actual `V2_LOCALHOST_CALLBACK_CONFIRMED` output before marking consent/callback proven.
- Callback success still does not establish token exchange, token refresh, Bitbucket tool execution or safe Workers handoff. All remain **NOT PROVEN / NOT IMPLEMENTED**.

## Successful mcp-remote cached registration: new operator evidence (2026-10-20)

The working tunnel's read-only inspection found one client registration with `client_secret_present=true`, `token_endpoint_auth_method=none`, the expected Atlassian Identity issuer and an eligible loopback redirect. This is direct evidence that **a secret in the server's DCR response is not inherently incompatible with a public client**. The Bridge's current registration validator already allows and ignores an unused secret if the method is `none`.

The cached registration response did **not** report `grant_types`, `scope`, `client_uri` or software metadata. This is not evidence those fields were omitted from the actual original DCR *request* by `mcp-remote@0.14.3`. Comparing the cached response with Bridge's request as though they were equivalent would be invalid. No new reason to increase Bridge's Bitbucket Read-only authorization scope has been established. See [operator sanitized response assessment](mcp-remote-dcr-inspection.md#operator-run-sanitized-result-2026-10-20-jst).
