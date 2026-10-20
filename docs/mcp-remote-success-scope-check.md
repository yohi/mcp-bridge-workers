# Safe offline comparison of previously successful OAuth scopes

Status (2026-10-20 JST): The owner reported that the new, isolated Bitbucket-Read-scoped mcp-remote@0.14.3 client received invalid_request / Incorrect request parameters after Accept. The previously working chatgpt-mcp-tunnel used the same mcp-remote version but did not explicitly pin Bitbucket-only scope.

**Conclusion so far:** Switching OAuth implementation alone did not fix the issue. The effective scope, different DCR client/registration, loopback configuration, and consent resource selection remain distinct. Neither a scope-only root cause nor an Atlassian server defect is proven.

Atlassian documents read:bitbucket:agent-interface as the necessary permission for read_bitbucket tools, but this does not establish it is sufficient for the whole OAuth consent flow. The v0.14.3 mcp-remote source writes a requested_scope string into its local tokens.json and may persist scope returned by the authorization server. We can inspect those two fields without starting any new OAuth registration.

## One offline check on the already successful tunnel

Run the following exactly on the trusted Linux workstation. It invokes Node rather than mcp-remote-client and does not send requests, write files or refresh tokens.

```bash
cd ~/program/private/mcp-bridge-workers
git pull
npm test

cd ../chatgpt-mcp-tunnel
docker compose --profile auth run --rm -T --no-deps \
  --entrypoint node auth - \
  < ../mcp-bridge-workers/tools/local-oauth/inspect-mcp-remote-token-scopes.cjs
```

The helper locally opens only files matching mcp-remote-v1/*_tokens.json and reads scope / requested_scope from them, although those files also contain sensitive authentication credentials. It outputs **only predetermined booleans and counts**. It never prints token strings, client IDs, exact scope names beyond the fixed classification labels, organization/tenant names or file paths. No network API calls are made. Do not upload the raw file, include detailed debug logs, or run the original OAuth/login command as a substitute.

## Interpreting the result

- requested_scope: effective requested scope stored by mcp-remote@0.14.3 when saving the existing successful token; it might differ from the exact URL scope when a server challenge overrides selection.
- granted_scope: stored server-returned token scope, when present. present=false does not mean permission was denied.
- read_me / read_account / offline_access: potential extra scope categories. They are not a reason to automatically add scopes.
- bitbucket_read / jira_read / confluence_read: selected permission group flags; the output intentionally does not print raw scope lists.
- contains_mutating_scopes: signals write/delete/manage scope names in that field. If true, do **not** copy the successful client's broad scope to the Bridge.
- Multiple records: this helper cannot identify which corresponds to the relevant account without revealing names. Report the count and stop; do not select one by guessing.

Even a favorable comparison cannot prove that scope alone caused the post-consent error; the new DCR registration and consent-resource selections also differ. No new DCR or login should be performed until a specific hypothesis and relevant approval are established.

## Status gates

- Original chatgpt-mcp-tunnel OAuth: success reported by operator, source of possible offline scope evidence.
- New isolated mcp-remote@0.14.3 with Bitbucket Read only: **failed after Accept** (operator report; no terminal logs for this new invocation have been independently inspected).
- Worker token handoff and enforced nested read-only boundary: not implemented.
- PR #2 remains Draft; no change to consent scopes or Worker secrets was made by this check.

Incident request UUID from the browser error page should be sent privately only if Atlassian support correlation later becomes necessary.

Unit tests use synthetic token files and verify that secrets, raw scope names and cache filenames are absent from the output.
