# Safe offline comparison of previously successful OAuth scopes

Status (2026-10-20 JST): The owner reported that the new, isolated Bitbucket-Read-scoped mcp-remote@0.14.3 client received invalid_request / Incorrect request parameters after Accept. The previously working chatgpt-mcp-tunnel used the same mcp-remote version but did not explicitly pin Bitbucket-only scope.

**Conclusion so far:** Switching OAuth implementation alone did not fix the issue. The effective scope, different DCR client/registration, loopback configuration, and consent resource selection remain distinct. Neither a scope-only root cause nor an Atlassian server defect is proven.

Atlassian documents read:bitbucket:agent-interface as the necessary permission for read_bitbucket tools, but this does not establish it is sufficient for the whole OAuth consent flow. The v0.14.3 mcp-remote source writes a requested_scope string into its local tokens.json and may persist scope returned by the authorization server. We can inspect those two fields without starting any new OAuth registration.

## One offline check on the already successful tunnel

Run the following exactly on the trusted Linux workstation. It invokes Node rather than mcp-remote-client and does not send requests, write files or refresh tokens.

```bash
cd ~/program/private/mcp-bridge-workers
git pull
npm install --ignore-scripts --no-audit --no-fund
npm test

cd ../chatgpt-mcp-tunnel
docker compose --profile auth run --rm -T --no-deps \
  --entrypoint node auth - \
  < ../mcp-bridge-workers/tools/local-oauth/inspect-mcp-remote-token-scopes.cjs
```

The helper locally opens only files matching mcp-remote-v1/*_tokens.json and reads scope / requested_scope from them, although those files also contain sensitive authentication credentials. It outputs **only predetermined booleans and counts**. It never prints token strings, client IDs, exact scope names beyond the fixed classification labels, organization/tenant names or file paths. No network API calls are made. Do not upload the raw file, include detailed debug logs, or run the original OAuth/login command as a substitute.

## Actual operator output (2026-10-20 JST)

The operator ran the existing successful tunnel's inspector and obtained `result=no_token_records` and `record_count=0`. This is a **completed read-only inspection with no matching persisted token files**, not an OAuth failure and not proof that the previously observed working tunnel never authenticated. The earlier registration inspection found one persisted `*_client_info.json`, but such registration metadata does not contain the actual requested/granted scope values. Thus **this line of scope comparison is BLOCKED_BY_MISSING_PERSISTED_TOKEN_EVIDENCE**. No further DCR registration/login is justified solely to make this diagnostic return data.

The same execution showed local `npm test` failing with `ERR_MODULE_NOT_FOUND: @mcp-bridge/core` because workspace installation had not been performed. Add the normal npm workspace install shown above; the Node.js v26.12.0 invocation has not independently been validated in CI (which uses 20 and 22). The failure is independent of the safe Docker inspection result.

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


## Operator-verified successful scope classification (2026-10-20 JST)

After logging in again to the existing **chatgpt-mcp-tunnel** (not to mcp-bridge-workers), the owner reran the local read-only scope inspector. The invocation returned exactly one parsed token metadata record. Only the allowlisted output classifications were provided; **no token, raw OAuth URL, client ID, tenant ID, DCR POST or scope string** is held in this repository.

| Scope dimension | Stored requested_scope | Stored granted_scope |
| --- | --- | --- |
| present | true | true |
| scope_count | 40 | 21 |
| read:me | true | true |
| read:account | true | true |
| offline_access | true | true |
| read:bitbucket:agent-interface | true | true |
| read:jira:agent-interface | true | true |
| read:confluence:agent-interface | true | true |
| Any scope with write:/delete:/manage: prefix | true | false |

Local `npm test` also reported **51/51 PASS** after workspace dependencies were available. The inspector returned `persisted_scope_metadata_inspection` with `record_count=1`. The previous `no_token_records` observation is superseded **for the current inspected cache**; it had not proven a permanent problem with the older successful tunnel.

**Interpretation and limits:**
- The successful `mcp-remote@0.14.3` flow persisted **more than Bitbucket Read alone** as its effective requested and granted scopes. The failed Bridge (both custom DCR and isolated `mcp-remote`) explicitly requested Bitbucket Read alone.
- `requested_scope` is the effective requested scope recorded by the client, not a raw capture of the actual browser authorization URL. `granted_scope` is the reported scope from the saved token response; it must not be confused with a security audit of all currently effective app permissions.
- A false `contains_mutating_scopes` checks only `write:`, `delete:` and `manage:` prefixes. It **does not certify complete read-only safety** or block deferred tool writes.
- **Not proven causal:** Missing `read:me`, `read:account`, `offline_access` could contribute to post-Accept rejection, but the working session also differs in DCR client registration, callback configuration and consented resource/app choices.
- Atlassian's [OAuth 2.1 guide](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/) says consent determines app/scope access, but does **not** establish that these three scope names are always required for a Bitbucket-only MCP login. The successful flow's broader scope request **must not** be copied wholesale.
- `offline_access` commonly enables token refresh, which is distinct from proving that consent itself requires it; retaining refresh-token capability demands separate security review.

**Next engineering step (offline first):** document a narrow, separately approved test candidate with only `read:bitbucket:agent-interface` plus identity-related baseline scopes (`read:me`, `read:account`), and separately assess whether `offline_access` is needed. Any live probe requires **one new DCR registration and human consent**, so it must be explicitly authorized and must not expand Jira/Confluence permissions or introduce write/delete/manage scopes. Do not run such a probe on the basis of this evidence alone. If consent fails again, stop and use private Atlassian error reference for escalation.

**Gates:** Successful original tunnel = operator observed; successful *restricted Bridge client* = NOT PROVEN / previously failed; cause = UNKNOWN; Worker handoff and nested read-only authorization = NOT IMPLEMENTED; PR #2 = DRAFT.
