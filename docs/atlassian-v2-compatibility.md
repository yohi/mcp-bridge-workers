# Atlassian Rovo MCP v2 compatibility

## Version policy (2026-10-20)

**MCP upstream MUST use v2:** `https://mcp.atlassian.com/v2/mcp`.

Atlassian announced Rovo MCP v2 general availability on **2026-09-08**, adding Bitbucket, Loom, and other products. The v1 toolset is not the right baseline for Bitbucket. Do not change the upstream URL to `/v1/mcp` or `/v1/mcp/authv2`; preserve `/v2/mcp` as a regression-tested contract.

**Important distinction:** `https://mcp.atlassian.com/v1/register` is the OAuth **Dynamic Client Registration endpoint advertised by the authorization server**. It is not the MCP transport endpoint and does **not** mean the bridge is using Rovo MCP v1. OAuth endpoints must be discovered and verified independently from the MCP URL; do not mechanically change `v1/register` to `v2/register`.

## Bitbucket prerequisites

- The Bitbucket Cloud workspace must be linked to an Atlassian organization.
- The Rovo MCP tool catalog includes `read_bitbucket` and `write_bitbucket` permission groups. Current v2 documentation lists OAuth 2.1 and API token options for both; required scopes are `read:bitbucket:agent-interface` and `write:bitbucket:agent-interface` respectively.
- Actual tool availability depends on the user's permissions, granted scopes, organization policy, and server tool discovery. Authentication success by itself is insufficient to prove Bitbucket access.
- The bridge PoC permits `discover` and `executeRead`, but this is **not a verified per-tool read-only control**. For production, implement scoped enforcement and verify the nested deferred tool ID and operation before forwarding.
- The upstream `tools/list` response is currently not filtered to match the bridge allowlist. Do not present this PoC as secure multi-tool gateway.

## Verify without authentication

```sh
npm test
npm run check:atlassian-oauth
```

These checks verify source configuration and publicly advertised authorization metadata only. They do not prove any tenant's Bitbucket availability.

## Sources

- https://developer.atlassian.com/changelog/ (2026-09-08 v2 GA announcement)
- https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/
- https://jira.atlassian.com/browse/BCLOUD-24072 (v2 Bitbucket OAuth support)
- https://support.atlassian.com/atlassian-ai-gateway/docs/get-started-with-the-atlassian-remote-mcp-server/
