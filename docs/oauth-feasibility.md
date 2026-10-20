# Atlassian Rovo MCP **v2** OAuth feasibility

Status (2026-10-20 JST): **v2 protected-resource and Atlassian Identity authorization metadata confirmed by operator; DCR registration HTTP success but response classification pending after a strict-validation false negative**. This project must NOT treat successful discovery of `https://mcp.atlassian.com/.well-known/oauth-authorization-server` as proof of v2 readiness.

## Why the earlier v1 login was wrong

The initial PR #2 discovery code used the legacy **root** OAuth metadata on `mcp.atlassian.com` and thereby selected:
- `https://mcp.atlassian.com/v1/authorize`
- `https://mcp.atlassian.com/v1/token`
- `https://mcp.atlassian.com/v1/register`

For the v2 resource this is an invalid discovery method. The new code must start at the v2 resource's protected-resource metadata:
`https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp`

That document supplies a tenant-scoped authorization server `https://auth.atlassian.com/<auth-server-id>`, whose **own** metadata specifies authorization, token and DCR registration URLs. Typical values:
- authorization: `https://auth.atlassian.com/authorize`
- token: `https://auth.atlassian.com/oauth/token`
- registration: `https://auth.atlassian.com/<auth-server-id>/dcr/register`

**Discover the ID. Do not hardcode a guessed ID or silently fall back to v1.** A public metadata advertisement is not proof that a specific organization's authorization or Bitbucket access works.

## Step 1: read-only v2 discovery

```bash
npm run check:atlassian-oauth
```

Expected fields for **successful metadata-only** evidence:
```json
{
  "result": "metadata_verified",
  "resource": "https://mcp.atlassian.com/v2/mcp",
  "resource_metadata": "confirmed",
  "authorization_server_metadata": "confirmed",
  "authorization_endpoint": "https://auth.atlassian.com/authorize",
  "token_endpoint": "https://auth.atlassian.com/oauth/token",
  "dcr": "advertised_only",
  "pkce_s256": "advertised_only",
  "bitbucket_read_scope": "advertised_only",
  "localhost_redirect": "not_tested",
  "token_exchange": "not_tested",
  "worker_handoff": "not_implemented"
}
```

The operator confirmed the v2 discovery fields on 2026-10-20. This is a representative subset, not a fresh authentication test. The full JSON contains the discovered tenant-scoped registration URL; avoid sharing any private organization details unnecessarily.

If `result` is `not_proven` or Bitbucket scope is `not_proven`, STOP. Do not run the optional probe until the discrepancy is investigated. The CLI exits nonzero when protected-resource or issuer metadata fails.

## Step 2: deliberate local DCR + browser callback experiment

Requires authorization under the Atlassian organization's policies. This command makes **one DCR POST**, registering an OAuth client with a unique local redirect URI. It is **not** a read-only check and must never be run by CI.

```bash
npm run probe:atlassian-localhost
```

The probe will:
1. Require trusted v2 discovery and explicit `read:bitbucket:agent-interface` support.
2. Generate ephemeral PKCE S256, random state, and an exact loopback callback `http://127.0.0.1:<random-port>/callback`.
3. DCR-register a public client against the **discovered Atlassian Identity** registration URL.
4. Request the **v2 resource** and *read-only Bitbucket scope* in the authorization URL.
5. After interactive consent, report the observed callback only; **discard the code** and do not request, persist or hand off tokens.

Only share a status such as `V2_DCR_ACCEPTED`, `V2_LOCALHOST_CALLBACK_CONFIRMED` or `V2_LOCALHOST_OAUTH_ERROR`. Do not paste the printed authorization URL, `state`, query-string `code`, IDs or tokens.

## DCR HTTP success with \`V2_DCR_INVALID_RESPONSE\`

The operator observed this status on 2026-10-20 after DCR returned a successful HTTP status. Because the old probe rejected the response when \`client_secret\` was present, this is **not evidence that Atlassian rejected localhost**, and the registration may have created a client. The response was not saved, so the exact failure condition cannot be reconstructed from the status alone.

A third-party September 2026 report documented that Atlassian v2 returns a \`client_secret\` even when a DCR client is registered with \`token_endpoint_auth_method=none\`:
https://github.com/QwenLM/qwen-code/issues/12165

The patched probe accepts a DCR response only if:
- \`client_id\` is a nonempty string;
- \`redirect_uris\` contains the **exact** \`127.0.0.1\` loopback callback;
- the **returned** \`token_endpoint_auth_method\` is literally \`none\`;
- any returned grant/response type still allows \`authorization_code\` / \`code\`.

A response \`client_secret\` is treated as an unusual Atlassian-specific extra field and **discarded**, never displayed, persisted or used. This is a metadata-only exception, not permission to handle confidential client credentials. The probe prints \`V2_DCR_PUBLIC_CLIENT_SECRET_IGNORED\` without the secret value. Unexpected method or redirect mismatch still stops the test and prints a sanitized reason.

**Do not run repeated DCR registration just to diagnose the prior client.** The original script did not persist a client ID; it cannot resume an abandoned registration. If a subsequent single fresh registration is authorized, the patched probe will classify it safely.

## Gates not passed

| Gate | State |
|---|---|
| Public v2 resource metadata in this environment | VERIFIED_BY_OPERATOR (metadata only) |
| Tenant-scoped DCR registration | HTTP_2XX_OBSERVED; valid public-client response NOT YET CONFIRMED |
| Organization-specific localhost loopback and Bitbucket consent | NOT TESTED |
| Token exchange and refresh | NOT IMPLEMENTED |
| Safe localhost-to-Worker token handoff | NOT IMPLEMENTED |
| Per-user authorization, nested tool enforcement and audited read-only policy | NOT IMPLEMENTED |
| Workers deployment and production connection | NOT STARTED |

A matching callback alone cannot prove that Bitbucket tools are accessible. The Bitbucket workspace must be linked to the Atlassian organization, and permissions plus tool scopes must be enforced. The bridge's existing `executeRead` allowlist is not a nested-operation authorization boundary.

## References

- Official Atlassian v2 endpoint: https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/
- Bitbucket OAuth availability (2026-10-15): https://www.atlassian.com/blog/bitbucket/connect-bitbucket-cloud-to-your-ai-tools-with-atlassian-mcp
- Atlassian OAuth provider migration announcement: https://community.atlassian.com/forums/discussion/3227514/atlassian-rovo-mcp-oauth-updates
- Discovery configuration example: https://www.truefoundry.com/docs/ai-gateway/mcp/atlassian-rovo-mcp-server
- OAuth Protected Resource Metadata (RFC 9728): https://datatracker.ietf.org/doc/html/rfc9728
