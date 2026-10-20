# Atlassian Rovo MCP **v2** OAuth feasibility

Status (2026-10-20 JST): **v2 protected-resource and Atlassian Identity authorization are NOT YET OBSERVED in this organization**. This project must NOT treat successful discovery of `https://mcp.atlassian.com/.well-known/oauth-authorization-server` as proof of v2 readiness.

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

This is a sample of expected fields, **not a claim that this environment has returned them**. The full JSON contains the discovered tenant-scoped registration URL; avoid sharing any private organization details unnecessarily.

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

## Gates not passed

| Gate | State |
|---|---|
| Public v2 resource metadata in this environment | NOT TESTED WITH UPDATED SCRIPT |
| Tenant-scoped DCR registration | NOT TESTED |
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
