# Atlassian OAuth 2.1 / DCR / localhost feasibility gate

**Status: PARTIALLY VERIFIED — not authorization to deploy or handle Atlassian credentials.**

Reference date: 2026-10-20 (JST). Public Atlassian metadata was independently inspected through read-only public browsing. No DCR registration, OAuth login, token exchange, actual Worker API call, or production authorization has been performed.

## Evidence and claims (do not collapse these states)

| Check | Current state | Meaning |
|---|---|---|
| Authorization-server metadata | PUBLIC_METADATA_OBSERVED | The root \`/.well-known/oauth-authorization-server\` currently returns metadata with issuer \`https://mcp.atlassian.com\` |
| OAuth authorization code | ADVERTISED_ONLY | \`authorization_code\` and \`code\` listed |
| PKCE S256 | ADVERTISED_ONLY | Does **not** prove localhost redirects will be accepted |
| Dynamic Client Registration | ENDPOINT_ADVERTISED | \`https://mcp.atlassian.com/v1/register\` appears as registration endpoint; no registration made by maintainers |
| Protected-resource discovery (RFC 9728) | NOT_CONFIRMED | Some clients have reported absent endpoints; root metadata is a separate check |
| Exact localhost redirect for this org | NOT_TESTED | Must observe a browser redirect with exact registered URI and matching state |
| Token exchange/refresh | NOT_TESTED | No code exchanged and no token retained by the probe |
| Worker handoff | NOT_IMPLEMENTED | Requires approved handling, key management, revocation, and authorization boundaries |
| Portal/Worker/Rovo integration | NOT_TESTED | No live use of company data |

Sources:
- https://mcp.atlassian.com/.well-known/oauth-authorization-server
- https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/
- https://developer.atlassian.com/cloud/rovo-mcp/guides/authentication-and-authorization/
- https://github.com/atlassian/atlassian-mcp-server/issues/246 (Atlassian staff reported a fix rollout on Oct 17, 2026; applicability to this org is unknown)

## Read-only verification

Requires Node 20+:

\`\`\`bash
npm run check:atlassian-oauth
\`\`\`

This command makes read-only unauthenticated GETs to fixed \`mcp.atlassian.com\` metadata endpoints. It returns conservative JSON fields, never credentials, and exits nonzero if trusted authorization-server metadata cannot be confirmed. The checks do not confirm organization-level policy, DCR acceptance, or login.

## Explicit opt-in localhost experiment (not a CI step)

**Preconditions:** The operator confirms organization policy allows this OAuth registration and login; use a local machine with a browser, not Cloudflare Workers. This creates an OAuth client at Atlassian if registration succeeds. It cannot be safely undone automatically by this tool.

\`\`\`bash
node tools/local-oauth/check-localhost-redirect.mjs --register
\`\`\`

1. Fetch trusted public metadata; require DCR and S256 advertising.
2. Bind a random loopback port on \`127.0.0.1\` (not a public interface) and compute exact callback \`http://127.0.0.1:<port>/callback\`.
3. POST a **new public client registration** to the trusted DCR endpoint, using the exact callback and \`token_endpoint_auth_method=none\`.
4. If registration is accepted, print an OAuth authorization URL for the local browser. Do not share it in issues, logs, or chat.
5. If the browser returns to localhost with matching \`state\` and a code, print \`LOCALHOST_CALLBACK_CONFIRMED\`. The authorization code is **discarded in memory without logging or token exchange**. A callback error or timeout is NOT proof localhost can never work.
6. Do not repeat until needed: unnecessary DCR registrations are undesirable.

**Important limitations:** A successful loopback callback only proves this one client/redirect and user authorization reached the local browser. It does not prove the code is redeemable, that refresh tokens exist, or that OAuth tokens can safely be moved to Workers. Some organizations restrict redirects even when metadata supports PKCE and DCR. This probe does **not** implement multi-user isolation.

## Next separate design gate (not part of this PR)

Before transporting tokens to Workers: independently verify token lifecycle, revocation, binding between Portal identity and Atlassian user, authorization and scope enforcement, confidentiality of credential storage, and organization approval. Treat any failed or inconclusive probe as BLOCKED/UNKNOWN rather than guessing.

If the organization enables noninteractive API tokens, they are a *different* alternative; do not silently substitute them for an OAuth decision.
