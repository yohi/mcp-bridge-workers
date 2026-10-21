# PR #3 — Bitbucket repository-list operation enforcement (Design R1)

**Status:** DESIGN_ONLY · IMPLEMENTATION_NOT_STARTED · DEPLOYMENT_NOT_AUTHORIZED  
**Baseline:** `master` at `5f88fcf47b85e1c102ef9c5deb2a6d67181c3ba7` (merged PR #2).  
**Date:** 2026-10-21 JST.

## Goal and non-goals

Add precisely **one** narrowly authorized Bitbucket capability to the existing ChatGPT → Cloudflare MCP Portal → Worker → Workers VPC → Tunnel → local Docker Relay → Atlassian Rovo MCP connection: list repositories in an **explicitly approved, fixed workspace**.

The production baseline must continue to expose only `atlassianUserInfo` and `getAccessibleAtlassianResources`. Do **not** set `ATLASSIAN_UNVERIFIED_READ_TOOLS=on`, expose unrestricted `discover` / `executeRead`, implement arbitrary queries, enable write or destructive tools, expand OAuth scopes, or change Cloudflare/Portal/Tunnel/Docker settings. No production changes or real Bitbucket data calls are in scope for this design PR.

## Evidence and remaining uncertainty

| Ref | Claim | Assessment |
|---|---|---|
| E-01 | Merged baseline passes master push CI: Node 20, Node 22, Docker | VERIFIED: [run 39569994489](https://github.com/yohi/mcp-bridge-workers/actions/runs/39569994489) |
| E-02 | Official Rovo MCP catalog lists deferred `listBitbucketRepositories` within `read_bitbucket`, requiring `read:bitbucket:agent-interface` | DOCUMENTED: [Rovo supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/) |
| E-03 | Bitbucket workspace must be linked to an Atlassian organization to use these Rovo tools | DOCUMENTED, actual linkage NOT VERIFIED |
| E-04 | Rovo uses `discover` to resolve deferred tool metadata, then `executeRead` for read-tier operations | DOCUMENTED, exact live descriptor NOT CAPTURED |
| E-05 | REST `GET /2.0/repositories/{workspace}` is a paginated read | DOCUMENTED: [Bitbucket REST repositories](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/) |
| E-06 | REST OAuth scope `repository` or Forge/API-token `read:repository:bitbucket` corresponds to Rovo scope `read:bitbucket:agent-interface` | **NOT EQUIVALENT**; do not substitute or request REST scopes |
| E-07 | Target workspace slug `diamondhead` | CANDIDATE ONLY; not verified against currently authenticated principal |
| E-08 | Current Bridge OAuth principal has effective `read_bitbucket` permission in this org | NOT PROVEN; do not infer from another client's saved scopes |
| E-09 | Exact deferred tool argument keys, omitCloudId behavior, and pagination/output envelope | NOT PROVEN; require schema-only evidence before implementation |

## Proposed capability contract (subject to G1/G2)

Expose a Worker-owned virtual tool with the external MCP name `listBitbucketRepositories`. This is **not** a generic passthrough to the Rovo deferred-tool catalog.

- Initially accept `tools/call` only with `name="listBitbucketRepositories"` and strictly empty `arguments={}`. Workspace is a fixed reviewed Worker setting, **never caller-specified**. Confirm the actual workspace before hard-coding; `diamondhead` is unverified.
- Advertise this one virtual tool through `tools/list` only when independently approved and deployed, alongside the two existing metadata tools. Pagination/caching logic must not duplicate the virtual tool or leak raw upstream tool definitions. Continue to hide `discover`, `executeRead`, `executeWrite` and `executeDestructive`.
- Worker constructs an **internal** upstream `tools/call` targeting literal `executeRead` with exact deferred `name="listBitbucketRepositories"` and a narrow `inputs` object filled solely from server-owned, schema-validated workspace configuration. Do not forward arbitrary operation names or request parameters.
- For Bitbucket operations, omit `cloudId` only when a captured official descriptor demonstrates it may be omitted. Never guess operation-specific field names or reuse a Jira/Confluence cloudId.
- First version returns only **one bounded page**; no free-form `next` URL following, query, sorting, role filter or multi-workspace scanning. Project upstream fields to a small normalized set (for example `name`, `slug`, `full_name`, `uuid`, `is_private`), after validating the real response schema.
- Preserve Portal Bearer and Relay Bearer, private VPC fetch, fixed destination, existing filtering and fail-closed handling. No public-Tunnel fallback. OAuth access/refresh tokens remain only in the local Docker volume.
- Reject unexpected JSON-RPC envelopes, mismatched request IDs, oversized/malformed responses, unexpected content type/SSE, 401/403/redirect, schema drift or missing permissions with sanitized errors. No upstream exception text, raw repository objects or credentials in logs.
- Do not enable the generic `executeRead` route even during a smoke test. The new dispatcher must be reachable **only after the existing Portal authentication check** and must independently enforce the exact operation and inputs.

**Design note:** Official naming and read permission tier are evidence of intended semantics, but not runtime proof of effective operation-level authorization. Never report universal read-only safety based on the tier label alone.

## Threat-control matrix

| Threat | Control |
|---|---|
| Direct generic `executeRead` or write/destructive call | Existing top-level deny remains; test 403 with zero upstream calls |
| Caller injects `name`, `inputs`, `operation`, `workspace`, `cloudId`, URL or pagination | External arguments are empty only; all upstream arguments synthesized from constant/schema-pinned server config |
| Rovo catalog changes operation name or risk tier | Pin observed exact descriptor; block on mismatch and re-review |
| OAuth principal has excessive privileges | Worker allows only one internal operation; separately inspect effective grants using sanitized metadata, never tokens |
| Atlassian organization denies workspace access | Fail closed without discovering alternative workspaces |
| Huge responses or pagination SSRF | Bound byte count/page count; never follow upstream `next` and never reflect raw links |
| Portal tool cache shows stale tools | Re-sync only the target MCP server after approved deployment; inspect tools/list |
| Connection failure or fallback attempts | Fail closed; VPC-only routing, no public hostname switch |
| Log leakage | No secrets, raw authorization data, repository names/IDs, or error bodies logged |

## Release gates (no silent advancement)

**G0 — PASS:** merged master baseline `5f88fcf4` and three CI jobs pass. Current Portal production has exactly two advertised tools.

**G1 — PENDING (operation contract):** acquire **schema-only**, sanitized evidence of `listBitbucketRepositories` parameters, `omitCloudId` property, permissions, pagination contract and exact operation name from a versioned official descriptor or separately authorized metadata-only inspection. Do not toggle production gates or execute the deferred operation for schema discovery. Abort on mismatch.

**G2 — PENDING (owner configuration):** confirm one authorized workspace slug, its organizational linkage, and acceptance of one-page listing. Do not assume `diamondhead` without confirmation.

**G3 — PENDING (effective authorization):** verify effective read Bitbucket permission for the actual Bridge OAuth identity, using only boolean/classification evidence. No token export, fresh DCR, user login or permission changes are implied.

**G4 — NOT_STARTED (implementation):** introduce one fixed virtual tool and internal dispatcher; keep both existing metadata tools and global nested tool disablement unchanged. Isolate provider-specific mapping from generic core, or add a separately reviewed narrow extension point to the core.

**G5 — NOT_STARTED (offline tests):** verify exact allowed single call, deny arbitrary operation/inputs/workspace/URL, no generic nested tool in list or calls, bounded response, pagination, mismatched ID, auth failures, 401/403, redirects, invalid SSE/JSON, logging hygiene, unchanged metadata-tool behavior, VPC fail-closed semantics. Run Node 20/22 and Docker CI.

**G6 — NOT_STARTED (controlled runtime):** separately authorize deployment, verify Portal now advertises exactly three tools (the existing two plus this virtual tool), use a constrained read-only smoke test without publishing actual private repository data. Confirm rollback to a known-good VPC Worker version; never to the Bot-Fight-blocked public hostname.

**G7 — PENDING (approval/merge):** independent code review plus owner acceptance of evidence and risk. Passing CI alone does not authorize Ready, deployment or merge.

## Alternatives

- **Reject:** set `ATLASSIAN_UNVERIFIED_READ_TOOLS=on` and rely on the name `executeRead` — broad unverified nested capability.
- **Defer:** direct Bitbucket REST requests from the Worker — would require a new OAuth credential lifecycle and break the local-token boundary.
- **Chosen design:** one virtual tool that maps to exactly one known Rovo `read_bitbucket` operation after schema and permission verification.

**R1 outcome:** proposed narrow architecture and public-source evidence are ready for independent review. Exact live tool schema, fixed workspace, effective OAuth privileges, implementation and runtime confirmation are still pending. This PR is **design-only Draft** and must not change production.
