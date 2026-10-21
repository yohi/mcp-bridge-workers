# Atlassian Rovo MCP v2 / Bitbucket contract

The MCP upstream MUST remain `https://mcp.atlassian.com/v2/mcp`.

**v2 MCP is not the same as the v1 OAuth authorization server.** The original proof-of-concept inadvertently read root metadata from `mcp.atlassian.com`, then used `/v1/authorize`, `/v1/token`, and `/v1/register`. These paths are **not valid evidence of v2 OAuth readiness**. PR #2 now requires v2 protected-resource discovery, an Atlassian Identity issuer, and v2 resource binding. It will fail closed instead of falling back.

The correct discovery sequence:
```text
mcp.atlassian.com/v2/mcp
  -> mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp
  -> auth.atlassian.com/<discovered-issuer>/.well-known/oauth-authorization-server
  -> auth.atlassian.com/authorize
  -> auth.atlassian.com/oauth/token
  -> auth.atlassian.com/<discovered-issuer>/dcr/register
```

The metadata check uses RFC 8414 path-insertion and issuer-scoped well-known discovery locations, validates the returned issuer and endpoints, and requires `read:bitbucket:agent-interface` to be advertised by the protected resource before browser experimentation. Do not assume that scope advertisement means an individual has access.

Bitbucket v2 requirements:
- Workspace linked to an Atlassian organization;
- `read:bitbucket:agent-interface` and corresponding permissions for read operations; `write:bitbucket:agent-interface` only when intentionally authorized;
- Actual end-to-end runtime proof of granted scopes and available tools.

The existing relay's `executeRead` allowlist does not enforce deferred nested operation IDs; its `tools/list` still may advertise tools that will be blocked. This remains experimental.

Sources:
- https://www.atlassian.com/blog/bitbucket/connect-bitbucket-cloud-to-your-ai-tools-with-atlassian-mcp
- https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/
- https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/
- https://www.truefoundry.com/docs/ai-gateway/mcp/atlassian-rovo-mcp-server
