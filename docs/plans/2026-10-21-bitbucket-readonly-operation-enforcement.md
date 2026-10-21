# PR #3 — Bitbucket repository-list operation enforcement (Design R2.1)

**Status:** DESIGN_R2_1_PROPOSAL / DESIGN_APPROVAL_PENDING / IMPLEMENTATION_NOT_AUTHORIZED / DEPLOYMENT_NOT_AUTHORIZED  
**Scope:** R2 → R2.1 limited revision of this document only; no source/test/config/CI changes.  
**Repository/PR:** `yohi/mcp-bridge-workers` / [#3](https://github.com/yohi/mcp-bridge-workers/pull/3), Draft.  
**Immutable review base:** `master` = `5f88fcf47b85e1c102ef9c5deb2a6d67181c3ba7`; reviewed R1 HEAD = `1ee110f8fb926743fc9ddefa562c8a3d170d09d0`; reviewed R2 HEAD = `6f0e3db970bc1917990c9e4f9b62ce0de85d3d65`.  
**Date:** 2026-10-21 JST.

## 1. Objective and immutable safety invariants

Expose **one** Worker-owned virtual tool, `listBitbucketRepositories`, to list a bounded page of repositories in **one Owner-approved fixed workspace** over ChatGPT → Cloudflare MCP Portal → Worker → Workers VPC → Tunnel → local Docker Relay → Atlassian Rovo MCP.

Maintain all invariants:
- Existing external metadata tools `atlassianUserInfo` and `getAccessibleAtlassianResources` remain supported. Only the one named virtual tool can be added after implementation approval.
- External `discover`, `executeRead`, `executeWrite` and `executeDestructive` **must not** be advertised or callable. `ATLASSIAN_UNVERIFIED_READ_TOOLS=off` remains mandatory; no switch to `on` and no generic read dispatcher.
- Workspace is from a validated, reviewed, **server-owned immutable configuration value**; no caller-provided workspace, tenant, `cloudId`, operation name, arbitrary query or URL may influence it.
- Internal `executeRead` is invoked only by Core from the exact registered virtual-tool branch, with **literal operation** `listBitbucketRepositories` and G1-pinned arguments.
- Portal Bearer and Relay Bearer remain separate, with unchanged authentication and local OAuth token storage. All upstream calls use the **existing fixed VPC service transport**; no public-Tunnel automatic fallback, no OAuth change or credential transfer.
- Existing error-denial logic and existing metadata tool behavior remain compatible. No new data access or production modification is authorized by Design R2.

## 2. Evidence and uncertainty ledger

| Ref | Evidence / claim | Current evidence state |
|---|---|---|
| E-01 | PR #2 merged into `master`; Node 20, Node 22 and Docker CI passed | **VERIFIED** at baseline `5f88fcf4`; [run 39569994489](https://github.com/yohi/mcp-bridge-workers/actions/runs/39569994489) |
| E-02 | Atlassian Rovo catalog describes deferred `listBitbucketRepositories` in `read_bitbucket` with `read:bitbucket:agent-interface` | **DOCUMENTED**, not live entitlement proof; [official catalog](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/) |
| E-03 | Rovo Bitbucket tools require applicable organizational workspace linkage | **DOCUMENTED**; actual linkage **NOT_PROVEN** |
| E-04 | Rovo's read-tier family is `executeRead`; its exact `listBitbucketRepositories` descriptor and nested parameters are not captured | **PARTLY DOCUMENTED** / **G1 PENDING** |
| E-05 | Bitbucket REST `GET /2.0/repositories/{workspace}` supports repository listing | **DOCUMENTED**, but its response/scope is **not** the Rovo contract; [REST reference](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/) |
| E-06 | Rovo scope `read:bitbucket:agent-interface` is different from REST `repository` and Forge/API-token `read:repository:bitbucket` | **SCOPE DISTINCT**; never substitute or expand scopes |
| E-07 | `diamondhead` is a candidate target workspace | **G2 PENDING**; not an approved configured value |
| E-08 | Active Bridge OAuth identity's effective Bitbucket read permission | **G3 PENDING**, cannot infer from a separate client's grant |
| E-09 | Rovo exact input properties, workspace enforcement, `cloudId` handling, actual `CallToolResult` representation, page/next evidence | **G1 PENDING** |
| E-10 | Current Core owns auth, top-level authorize/filter, private fetch, 401/403/redirect handling; Worker only passes static config | **VERIFIED_FROM_BASELINE_SOURCE**, not implementation of virtual tools |

No `E-03` / `E-07` / `E-08` / `E-09` evidence is promoted to proven by this revision.

## 3. R1-FND-001: one implementation architecture and responsibility boundary

### 3.1 Exclusive choice

**Select exactly one architecture:** an **optional, single-slot virtual-tool extension to existing `createMcpRelay()` in Core**. No Core restructuring, plugin loader, arbitrary extension registry, second HTTP client, new Worker-side proxy server, or provider-specific code in shared Core. Provider-specific tool metadata and mapping are defined by the Atlassian Worker.

| Responsibility | Owner | Required behavior |
|---|---|---|
| Portal Bearer check, URL/method restrictions, JSON parsing/size limit, outer JSON-RPC validation | **Core** | Must run **before** any virtual-tool dispatch; preserve 401/403 contracts |
| External `tools/call` top-level tool authorization | **Core** | Existing two tools via current allowlist; virtual name through a separate exact match; generic `executeRead` always denied |
| External `tools/list` response validation and list filtering | **Core** | Reuse bounded parser; **after** filtering, append one Worker-declared virtual definition only on first page |
| Virtual tool public schema/description and fixed internal operation identifier | **Atlassian Worker** | No caller-controlled replacement |
| Owner-approved workspace constant and exact G1-validated upstream input builder | **Atlassian Worker** | Validate at startup/config use; no permissive default |
| Rovo result extraction and fixed projection into public repository fields | **Atlassian Worker** | Validate known result variant and field mapping; throw sanitized classified failure |
| Sending internal `executeRead` over existing authenticated fixed VPC route, bounded streaming response, JSON-RPC id comparison, error mapping | **Core** | One internal invocation only; no HTTP public fallback; never send raw response back |
| Sanitation/output envelope/`CallToolResult` construction | **Core** | Return only normalized Worker projection; preserve existing metadata-tool passthrough |
| Tests | **Later implementation PR** | Cover the new slot plus regression of all unchanged routes |

### 3.2 Proposed API/type shape (design contract, not implemented code)

~~~ts
type ExternalEmptyArguments = Record<never, never>;  // runtime check, not TS typing alone
type ApprovedWorkspace = string;  // G2-approved literal; strict allowlist validation
interface OwnerWorkspaceApproval {
  readonly slug: ApprovedWorkspace;       // compiled Worker literal after G2
  readonly ownerDecisionRef: string;       // permalink to approved immutable decision commit
  readonly ownerDecisionSha256: string;    // hex digest of the reviewed decision bytes
}
// Runtime Worker env holds BITBUCKET_WORKSPACE_SLUG independently;
// both values are required, never derived from caller arguments or each other.
interface WorkspaceBinding {
  readonly approved: Readonly<OwnerWorkspaceApproval>;
  readonly envKey: "BITBUCKET_WORKSPACE_SLUG";
}
type G1PinnedInputs = unknown;     // P-01: replace with evidence-pinned exact type before G4
type G1PinnedToolResult = unknown; // P-02: replace with exact observed MCP result variant before G4

interface RepositoryRowV1 {
  name: string;
  slug: string;
}
interface RepositoryPageV1 {
  schemaVersion: 1;
  workspace: string;
  repositories: RepositoryRowV1[];
  truncated: boolean;
}
interface VirtualToolSpec {
  publicName: "listBitbucketRepositories";
  description: string; // reviewed static description
  inputSchema: {
    type: "object";
    properties: Record<never, never>;
    additionalProperties: false;
  };
  internalToolName: "executeRead";
  internalOperationName: "listBitbucketRepositories";
  workspaceBinding: Readonly<WorkspaceBinding>;
  buildInputs: (ctx: Readonly<{workspace: ApprovedWorkspace}>) => G1PinnedInputs;
  // Decoder MUST verify the pinned Rovo result variant before returning a page.
  normalize: (result: G1PinnedToolResult, ctx: Readonly<{workspace: ApprovedWorkspace}>)
    => RepositoryPageV1;
}

// Existing config remains; only this optional ONE slot is added.
createMcpRelay({
  name, upstreamUrl, allowedTools,
  virtualTool: atlassianBitbucketVirtualTool // optional; absent = current behavior
});
~~~

`virtualTool` is an **in-process immutable description**, not an arbitrary remote plugin or callback supplied by a request. Core must validate that this slot is defined **once**, `publicName` does not collide with an upstream/existing metadata tool, and the internal tool/operation literals match the pinned approved contract. No dynamic tool registration, arbitrary handler lists or provider-controlled direct `fetch` callback is permitted.

**Owner approval is not established by a hash alone.** Core validates byte-for-byte equality of the approved literal and runtime binding; a separate offline review/CI check must verify that `ownerDecisionRef` resolves to the G2 Owner-approved immutable record and that `ownerDecisionSha256` matches that record. An unreviewed Worker source change to `approved.slug` is not authorized merely because its paired runtime setting was edited. The owner approval record does **not exist yet**; creating one belongs to a later separately authorized stage, never this R2.1 edit.

**Pending type freeze:** `unknown` placeholders `G1PinnedInputs` and `G1PinnedToolResult` mean **the interface is not implementable yet**. G1 must capture and replace them with literal, exact property/type shapes and decoding rules in a separately reviewed **Design R2 contract-completion revision** before G4. Implementers must not choose structures by guesswork.

### 3.3 Deterministic dispatch pipeline

1. Core recognizes authenticated `POST /mcp` only after current Portal Bearer and method/path checks, bounded body read and JSON-RPC validation. Existing `server/discover` compatibility reply remains unchanged.
2. If `tools/list`: forward through existing VPC route; run current bounded JSON-only `filteredToolListResponse`, preserving base top-level metadata allowlist and pagination; **after successful full validation**, if and only if this is the **first page** (no `params.cursor`, with `params` absent or empty), append one static virtual-tool descriptor. If existing filtered or unfiltered upstream list already includes the virtual name, fail closed (`VIRTUAL_CONTRACT_MISMATCH`), never append duplicates. Do not append on cursor pages. Retain upstream `nextCursor` unchanged if valid; no in-band permission increase from pagination. Do not expose the virtual name in failed/invalid list responses. On any unexpected `tools/list` request shape that would make "first page" ambiguous, reject rather than guess.
3. If `tools/call`: test requested `params.name` **against the already-approved public metadata names OR the single virtual publicName only**. Any direct `executeRead`/`discover`/write/destructive call fails at the existing outer 403 boundary without contacting upstream. A virtual name is not inserted into the existing generic `permittedTools` set.
4. For the virtual name, Core requires exactly the two `params` fields `name` and `arguments`; `arguments` must be a non-array plain object with **zero own keys**. Any missing, null, extra fields, workspace override, `_meta`, or extra argument is rejected **before transport**. If a Portal client necessarily adds an extra field, that is a G1 contract issue; do not silently relax validation.
5. Core checks the `virtualTool.workspaceBinding` at every virtual `tools/call` and before virtual `tools/list` advertisement: (a) compiled approved slug + nonempty immutable Owner decision reference and 64-digit lowercase SHA-256 of that decision; (b) `env.BITBUCKET_WORKSPACE_SLUG` present as a string with **no fallback**; (c) both slugs satisfy the fixed conservative ASCII policy and compare **exactly** (same case and bytes, no trimming, decoding, case folding, prefix matching or aliases); (d) `ATLASSIAN_UNVERIFIED_READ_TOOLS === "off"` and `ATLASSIAN_UPSTREAM_MODE === "local_relay_vpc"`. Any failed guard means no virtual dispatch, no virtual tool advertisement, and `-32050` on a direct virtual call; existing metadata tools remain on their original routes. After this guard, Core calls Worker-owned `buildInputs({workspace: approved.slug})` using only the approved literal. No caller body/header or unchecked runtime string reaches the mapper. Core never trusts a Worker-supplied "already validated" flag.
6. Core builds the **sole** internal request with `method="tools/call"` and `params.name="executeRead"`. The internal request can only be emitted by this code branch, never recursively passed through the external tool-authorization dispatcher. In a dedicated internal dispatch path, it invokes the **same Core fetch/authorization-header creation and existing VPC Service Binding**, using `LOCAL_RELAY_BEARER_TOKEN`. It does **not** set `ATLASSIAN_UNVERIFIED_READ_TOOLS=on`, modify `permittedTools` or add an external generic `executeRead` permission.
7. Core consumes the internal reply under explicit byte/time budgets, validates HTTP status and the JSON-RPC envelope/ID, then hands only the validated G1 result representation to the Worker normalizer. Normalizer emits `RepositoryPageV1` or a fixed classified failure; Core checks output schema/size and constructs the sanitized MCP `CallToolResult`. Original Rovo content and secret-bearing headers are never returned.
8. Legacy `initialize`, `notifications/*`, `ping`, existing two metadata `tools/call`, existing 401/403 handling and `/health/vpc` do not take the virtual path. `GET` and `DELETE` remain on the current implementation path; no new virtual invocation from them.


### 3.4 R2.1 fixed-workspace supply, validation and approval lifecycle (R1-FND-001)

**Single authoritative binding design:** The G2 Owner decision is recorded in a reviewed, immutable-commit Git governance decision artifact (an exact commit-pinned permalink, not a mutable branch URL). The approved `slug` and the SHA-256 of the exact decision bytes are pinned as **literal constants in the Atlassian Worker source** under `virtualTool.workspaceBinding.approved`. These constants are **not populated from environment variables**. Separately, a required Worker **plain-text runtime variable** `BITBUCKET_WORKSPACE_SLUG` supplies the deployed configuration value. Both are absent/unapproved today; **do not add them to source, Wrangler or Cloudflare during this document-only revision**.

The sole Core interface is `virtualTool.workspaceBinding: {approved:{slug,ownerDecisionRef,ownerDecisionSha256},envKey:"BITBUCKET_WORKSPACE_SLUG"}`. Core reads `env.BITBUCKET_WORKSPACE_SLUG` itself **inside the authorized route**, not through a caller-selected key; `envKey` must exactly equal its single allowed literal. It validates both slug strings against an **application-local conservative syntax** `^[a-z0-9][a-z0-9_-]{0,62}$` (ASCII only, no whitespace or decoding; **not an assertion about all Bitbucket-legal slug forms**), rejects invalid approval reference/digest shape, and compares the slugs by strict `===` equality. No missing-variable default, substitution with `diamondhead`, reflected caller value or permissive match. If the Owner-approved workspace cannot fit this syntax, revise the design and re-review before G2/I-AUTH; do not silently normalize.

- **At design/G2:** Human Owner approves one slug and the record's exact version/hash. Reviewer/CI must match the source-pinned literal/ref/hash against that independent Owner decision record. Merely setting both values to the same string is **not** proof of Owner approval.
- **At future deployment:** The deployment reviewer confirms `env.BITBUCKET_WORKSPACE_SLUG` exactly equals the compiled approved literal. Cloudflare Dashboard or Wrangler edits to the runtime binding cannot authorize a new workspace by themselves.
- **At every virtual request:** Core independently rechecks approved-literal/config equality, local syntax, `off` flag and VPC mode before any upstream request; invalid/missing/mismatched binding produces `HTTP 503 / JSON-RPC -32050` and **zero VPC calls**. For `tools/list`, retain existing metadata tools but do not append the virtual tool while invalid; never claim virtual capability is ready.
- **Any workspace, decision reference/digest, source-pinned approval, runtime binding or org linkage change:** revoke the prior design's authorization applicability, require a **new Owner decision** and immutable evidence ref/hash, independent review, fresh tests and explicit redeployment authorization. Until synchronized and approved, keep the virtual tool disabled. This is release governance plus runtime drift detection; the decision ref/hash is **not** an online signature or a runtime lookup of GitHub.
- **Cancellation/revocation:** immediately disable the virtual tool via an approved fail-closed operational action; do not interpret an existing compiled literal as continuing authorization after revocation. The system currently has no automatic real-time revocation watcher; that residual limitation must be resolved operationally prior to any live rollout.

**Hard stop P-03 remains:** `diamondhead` is merely a candidate; no Owner decision, exact slug, evidence artifact or real Cloudflare setting is created by R2.1. The type shape is frozen but the actual values are **PENDING G2**.

## 4. R1-FND-002: external and internal contracts

### 4.1 Published `tools/list` schema (fixed design choice)

Only after G1–G3 and later implementation authorization, the virtual tool is advertised as:

~~~json
{
  "name": "listBitbucketRepositories",
  "description": "List up to 25 repositories from the approved Bitbucket workspace (first page only).",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
~~~

**Allowed external call** has explicit `params.arguments={}` (empty plain object), a valid string/number `id`, and no extra `params` keys:

~~~json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "tools/call",
  "params": {
    "name": "listBitbucketRepositories",
    "arguments": {}
  }
}
~~~

`arguments` omitted, null, array, nonempty, or containing `workspace`/`name`/`inputs`/`cloudId`/`url`/`cursor` is **invalid**; do not forward. Caller-provided top-level RPC `id` is allowed only as an identifier, not as operation input. Reject batch arrays/notifications lacking a request ID for virtual invocations. External schema and strict runtime enforcement both required; the schema alone is insufficient.

### 4.2 Internal Rovo request structure (partially frozen pending actual descriptor)

**Fixed** outer structure:

~~~json
{
  "jsonrpc": "2.0",
  "id": 17,
  "method": "tools/call",
  "params": {
    "name": "executeRead",
    "arguments": {
      "name": "listBitbucketRepositories",
      "inputs": "<G1_PINNED_OBJECT_NOT_YET_KNOWN>"
    }
  }
}
~~~

The `"<G1_PINNED_OBJECT_NOT_YET_KNOWN>"` value is **design notation, not a valid implementation value or instruction to send a string**. G1 must replace the entire internal `inputs` value with the exact descriptor-confirmed object and workspace parameter name(s), including any required `cloudId` field or mandatory defaults. The final internal envelope must be frozen **before** implementation, and the value of every non-constant field must come only from vetted server-owned configuration. No arbitrary `responseFields`/`view` selectors or Rovo option keys may be added by an implementer.

The internal request `id` equals the validated external request `id` for this **one HTTP request**; the existing local Relay already rewrites stdio correlation IDs. Core MUST compare the internal HTTP response `jsonrpc="2.0"` and `id` to this exact ID (strict type and value equality), and reject absent/mismatched IDs; no relay of another request's result. This is a design-level new validation only for the virtual path.

**Workspace binding proof:** G1 must demonstrate that the Rovo operation actually scopes its query to one specified workspace, rather than silently listing all accessible workspaces. If that cannot be established, the fixed-workspace requirement is **NOT_MET**; no implementation or fallback to a broader tool/API is permitted.

### 4.3 Upstream `CallToolResult` handling and output schema

Upstream response is **not** assumed to be a repository array or generic JSON text. G1 must record which actual Rovo `CallToolResult` variant supplies data (e.g., `content` text versus `structuredContent`) and whether `isError` or JSON-RPC `error` can occur. These examples name MCP constructs, **not claims that Rovo uses a particular field**.

Only after a G1-verified extractor has validated the **exact** envelope, schema, and error markers may the Worker normalizer produce the following stable external projection:

~~~ts
interface RepositoryPageV1 {
  schemaVersion: 1;
  workspace: string;       // approved fixed server-owned value
  repositories: Array<{
    name: string;           // nonempty UTF-8, max 256 bytes
    slug: string;           // nonempty UTF-8, max 128 bytes
  }>;                      // max 25 entries
  truncated: boolean;      // true iff additional records/page exists
}
~~~

Only `name` and `slug` are included: no clone URL, description, owner, UUID, privacy controls, credentials, or raw upstream metadata. **P-02** requires G1 proof that both can be correctly, unambiguously and safely derived from the actual Rovo result. If either is unavailable, the R2 external projection is **NOT_FROZEN** and must be revised and re-reviewed **before G4**, not replaced with guesswork or empty strings.

Core publishes a **newly constructed** MCP JSON-RPC result with `CallToolResult`:
- `jsonrpc: "2.0"` and original validated request `id`.
- `result: { content: [{ type: "text", text: JSON.stringify(RepositoryPageV1) }], isError: false }`. No raw `structuredContent`, embedded raw error, upstream header, or upstream `content` passthrough.
- `content` consists of **exactly one** text item. `result` has no arbitrary extra fields.
- On any error, return an explicit sanitized JSON-RPC `error` as specified in `4.5`, **not** a raw Rovo `CallToolResult` and not an ambiguous empty successful result.

**Pagination rule:** return **only the first upstream page**. No server-side auto-pagination or following `next`/cursor URLs. In `RepositoryPageV1`, `truncated=true` if **(a)** the actual response has a validated next-page indicator, or **(b)** more than 25 valid items arrived in that first page. `truncated=false` is allowed only if G1 proves there is neither additional page nor omitted item. Never return a continuation token/URL externally. If next-page detection cannot be verified from Rovo's observed schema, this design **cannot truthfully implement `truncated` and must be re-reviewed before implementation**; do not default to false.

### 4.4 Bounds and validation order (fixed)

| Constraint | R2 ceiling / rule |
|---|---|
| External incoming body | Existing Core 262,144 bytes; do not loosen |
| Upstream virtual reply | **262,144 bytes maximum**, checked on declared length and incrementally while reading; cancel on excess |
| First-page output items | **25 maximum**; over-limit first page means truncate to 25 **only if** schema and next-page indicator are validated |
| Projected field | `name` <= 256 UTF-8 bytes; `slug` <= 128 UTF-8 bytes; both nonempty, validated as strings |
| Serialized external `CallToolResult` JSON | **65,536 bytes maximum** (UTF-8 encoded), including JSON-RPC envelope |
| Internal transport | One use of existing fixed VPC endpoint and Relay Bearer; no retry and no fallback |
| Response time | **30 seconds maximum** for virtual fetch/read/normalization (dedicated abort; no change to legacy routes) |
| First-page cursor | Not accepted from caller; no continuation URL sent to upstream |
| JSON-RPC id | Strictly equal type and value to validated external id |

Validation sequence is **mandatory**: (1) existing Portal auth and bounded RPC parse; (2) external name/empty args and approved workspace/config; (3) construct fixed internal request and VPC route; (4) check internal HTTP status/redirect and `content-type=application/json`; (5) enforce reply bytes **before** JSON parse; (6) UTF-8 fatal decode; (7) strict JSON-RPC envelope and ID matching; (8) reject JSON-RPC `error`, `isError` or unexpected `CallToolResult` representation; (9) verify G1-pinned Rovo data schema/workspace filter/next-page evidence; (10) normalize/limit item count and strings; (11) check serialized output ceiling; (12) return sanitized new `CallToolResult`. A non-200 upstream HTTP response never becomes a success by containing parseable JSON.

Do **not** implement a generic "find repositories anywhere in response" decoder. Any unknown fields/variant, permission failure or schema drift must follow an explicit classified error; never silently drop unrecognized entries in a way that would falsely claim a complete page.

### 4.5 External error taxonomy (fixed messages, no secret data)

Preserve existing Core contracts for nonvirtual paths. For the **virtual** path, all post-auth failures use a sanitized JSON-RPC `error` envelope with the original request ID (or null for invalid id). The table's protocol codes/messages are **design-assigned**, not claimed to originate from Rovo.

| Failure | HTTP | JSON-RPC code | Exact public `message` | Rule |
|---|---:|---:|---|---|
| Missing/invalid Portal bearer | 401 | n/a | `{"error":"unauthorized"}` (existing Core format) | Existing auth runs before virtual handler |
| Disallowed direct tools or virtual name not configured | 403 | -32001 | `MCP tool is not on the allowlist` | Existing Core denial; no upstream |
| Virtual input invalid / missing args or id | 400 | -32602 | `Invalid listBitbucketRepositories arguments` | New Core validation; no upstream |
| Approved workspace or VPC binding missing | 503 | -32050 | `Bitbucket read route not configured` | No fallback; no upstream |
| Upstream returned HTTP 401/403 | 502 | -32051 | `Bitbucket upstream authorization failed` | Do not surface auth challenge; does **not** assert workspace ACL denial |
| Independently recognized Rovo workspace permission denial | 403 | -32052 | `Bitbucket workspace access denied` | **P-04:** G1 must provide verified error code/shape; absent mapping use generic failure |
| VPC exception, timeout, HTTP 5xx or unexpected HTTP redirect | 502 | -32053 | `Bitbucket upstream unavailable` | No exception body/redirect exposed |
| Malformed response, unexpected `CallToolResult`, JSON-RPC id mismatch, oversized body, output mismatch or schema drift | 502 | -32054 | `Bitbucket upstream response rejected` | No raw upstream JSON/logging |
| Any unrecognized upstream JSON-RPC error | 502 | -32055 | `Bitbucket operation failed` | Generic sanitized failure; no invented authorization meaning |

For a virtual failure, return only `{jsonrpc:"2.0", id, error:{code,message}}` with `cache-control:no-store` and JSON content-type; never attach upstream body or WWW-Authenticate, Cookie, Location or Access headers. Existing metadata operations continue on the **unchanged** Core response path.

**P-04:** Rovo error representation is not yet known. Permission-denied mapping `-32052` MUST stay disabled until exact reviewed evidence distinguishes it from generic or transport errors. Unknown responses use `-32054` or `-32055` as appropriate; no heuristic matching of raw text.


### 4.6 R2.1 G1 evidence acquisition and decision rule (R1-FND-002)

**Permissible evidence tiers (do not conflate):**

- **S — Static/contract evidence:** version- and hash-pinned Atlassian official documentation, machine-readable tool descriptor/OpenAPI/source at a reviewed exact revision, plus derivation notes. Can establish *advertised types/declared behavior*, but **cannot by itself prove runtime output, workspace isolation or observed errors**.
- **H — Historic execution evidence:** a pre-existing, **separately authorized**, traceable, redacted fixture or observation: source version, timestamp, authenticated principal classification, exact requested operation/workspace classification, full response *shape* and status without tokens or private repository details, independent hash and testable provenance. A verbal success report or synthetic mock is not H.
- **L — New controlled runtime evidence:** a separately approved future operation test with Owner authorization, least privilege, bounded scope, sanitization and no source/production changes implied by this document. **Not authorized in this R2.1 task.** Without an authorized run, do not produce L or infer it from S.
- **T — Synthetic tests:** validate a proposed parser/transport/error classifier **only after implementation authorization**, not the real Rovo behavior. T is never proof that Rovo returned a particular field or applied a workspace filter.

For every subclaim, record `evidence_id`, vendor/tool version or commit, immutable source locator/digest, acquisition method/time, observed vs inferred classification, reviewed schema/response envelope (redacted), independent reviewer, and any unresolved counterexample. No raw OAuth payload, personal ID, client secret or repository data belongs in this PR.

| G1 item | Allowed evidence | Required validation | PASS condition | PENDING / BLOCKED condition |
|---|---|---|---|---|
| **G1-01 internal `executeRead` input schema (P-01)** | S exact versioned `listBitbucketRepositories` descriptor + documented `executeRead` family; H/L if S omits required properties | Derive exhaustive nested `arguments.inputs` keys, types, required/optional/defaults, `cloudId` behavior, workspace selector and stable operation identifier; independently compare sources | `CONTRACT_PASS` only if complete pinned descriptor and exact internal envelope, no unknown required field. `RUNTIME_PASS` only with H/L proving acceptance, if required by contract | S fragment, inferred field names, unresolved required params or version mismatch → **G1-01 BLOCKED** |
| **G1-02 `CallToolResult` shape (P-02)** | S source/descriptor of actual result path **and** H/L sanitized success/error envelope when observable shape is runtime-dependent | Identify JSON-RPC `result` vs `error`, `content`/`structuredContent` variant, `isError`, text parsing boundaries and bounded decoding; map only proven form | Exact extraction algorithm derivable from pinned S; any runtime-dependent variant is confirmed by H/L with provenance | Generic MCP examples alone, inferred JSON array or absence of real variant evidence → **BLOCKED** |
| **G1-03 `name` / `slug` normalization (P-02)** | Versioned S with field definitions **and** H/L redacted actual success shape, or exact versioned upstream serializer proof without execution (contract-only, runtime unproven) | Confirm paths, primitive types, nonempty requirements, UTF-8 ceilings, rejection of partial/missing/ambiguous elements; independent fixture/schema cross-check | Contract mapping is complete, fields exist and can be derived without guessing; empirical correctness marked RUNTIME_PASS only with H/L | Unclear field origins, conflated REST/Rovo shapes, synthetic-only output → **BLOCKED**, redesign external projection |
| **G1-04 next-page and `truncated` (P-02)** | S official versioned pagination contract; H/L shape(s) for continuation and end-of-page when runtime-dependent | Validate true/false and over-25 signals, no client next URL, deterministic first-page limit, handling exactly25 without next, absent signal and unknown cursor formats | Exact and unambiguous completeness predicate documented; H/L needed to mark observed runtime behavior | Cannot distinguish no-more-page from unknown/missing signal, no evidence for next-state semantics → **BLOCKED**, never default false |
| **G1-05 workspace scoping (P-01/P-06)** | S pinned implementation/API contract showing workspace applied server-side **plus** H/L separately authorized request/response or attested runtime trace where enforcement requires execution | Trace approved slug → exact upstream input → upstream server-side filtering, verify no all-workspace fetch followed by local post-filter, negative/mismatch handling | CONTRACT_PASS for verified binding; **RUNTIME_PASS requires H/L** demonstrating actual requested operation is bounded to that workspace | Metadata label only, post-filtered all-workspace result, silent workspace ignore, lacking runtime proof → **G1 BLOCKED / FIXED_WORKSPACE_NOT_PROVEN** |
| **G1-06 permission denial (P-04)** | S pinned documented Rovo error variant plus H/L denial-shape evidence when response classification is runtime-dependent | Distinguish HTTP 401/403 vs HTTP 200 + validated JSON-RPC denied result; check exact machine-readable codes, never inspect raw error text heuristically | `-32052` may be enabled **only** with exact unambiguous confirmed error code/shape; otherwise classify generically | Missing exact evidence → **P-04 PENDING** and disable `-32052`, not a false PASS; G1 can proceed only if generic failure mapping is retained |
| **G1-07 non-200 HTTP status taxonomy** | Existing Core source at immutable base + normative HTTP semantics (S); controlled T tests later; H/L only to prove specific Rovo status occurrence | Enumerate every status class and transport exception, precedence before parsing body, no upstream auth/header leak, sanitize output | **DESIGN_CONTRACT_PASS** when full mapping below is fixed; tests required at G5; source-specific Rovo occurrence never inferred from S | Any unclassified status or body-parsing fallback → **BLOCKED**; live behavior remains NOT_RUNTIME_PROVEN |

**Aggregate G1 rule:** `G1 PASS` requires all mandatory interface/data/workspace contract elements above, verified G1-05 **runtime** scoping evidence (not mere metadata), a complete pinned response-normalization and completeness predicate, and independent contract review. `G1-06` may remain PENDING **only if** its specialized `-32052` classification stays disabled with generic fail-closed behavior. `G1-07` can be DESIGN_CONTRACT_PASS while G5 runtime-free transport tests remain unrun; this is not a claim of actual Rovo status occurrence. If existing H cannot prove a necessary behavior, G1 stays **PENDING/BLOCKED** until a *new separately authorized* L acquisition or a revised design. **No probe, discovery, token inspection, Bitbucket enumeration or OAuth operation is authorized now.**

**Exhaustive HTTP precedence for the virtual path:**

| Actual HTTP/transport outcome | External classification | Validation rule |
|---|---|---|
| **200** | Continue to body validation only | Only 200 may produce success; even HTTP 200 with JSON-RPC `error` or `isError` fails |
| **401, 403** | `502 / -32051 Bitbucket upstream authorization failed` | Do not parse/forward body, cannot infer exact workspace ACL, ignore WWW-Authenticate |
| **408, 429** | `502 / -32053 Bitbucket upstream unavailable` | Treat transient status as unavailable; **no automatic retry**, do not follow Retry-After |
| **300–399** | `502 / -32053 Bitbucket upstream unavailable` | Redirects rejected, no Location follow/reflect |
| **500–599** | `502 / -32053 Bitbucket upstream unavailable` | Generic 5xx; no raw server error |
| **Other 400–499** (including 400,404,405,409,422) | `502 / -32055 Bitbucket operation failed` | Classified generic upstream refusal, no body parsing or speculation |
| **Other 200–299** (including 201,202,204,206) | `502 / -32054 Bitbucket upstream response rejected` | Strict 200-only protocol; 204/no body/206/partial not success |
| **100–199 or out-of-range status** (if represented) | `502 / -32054 Bitbucket upstream response rejected` | Unexpected status fail closed; not silently normalized |
| **Network error, VPC exception, timeout/abort, no Response object** | `502 / -32053 Bitbucket upstream unavailable` | Catch and sanitize; no public fallback |
| **HTTP 200 with invalid/mismatched JSON-RPC ID, schema, missing page state or excessive size** | `502 / -32054 Bitbucket upstream response rejected` | Mandatory ordered schema/byte validation |
| **HTTP 200 with valid known Rovo permission denial** | `403 / -32052 Bitbucket workspace access denied` **only if P-04 closed** | Otherwise use `502 / -32055 Bitbucket operation failed`; never reinterpret HTTP 403 body |
| **HTTP 200 with other recognized/unknown JSON-RPC error** | `502 / -32055 Bitbucket operation failed` | Generic fixed error; no upstream details |

The `4.5` error codes/messages remain authoritative; this table supplies **complete HTTP status mapping** and rejects any ambiguous pass-through. A status outside these cases is a contract violation, not an invitation to guess. Error classification takes place before any attempt to normalize repository data.

## 5. Pending decisions, falsification conditions and hard stop

| Pending | Gate | What must be established | Hard failure / required response |
|---|---|---|---|
| **P-01** | **G1** | Exact `listBitbucketRepositories` descriptor/version, `executeRead.arguments.inputs` keys/types, required workspace key, `cloudId` semantics and accepted defaults | If exact keys cannot be proven, **no G4**. Do not invent names, make generic executeRead callable or substitute direct REST |
| **P-02** | **G1** | Actual `CallToolResult` JSON shape, precise data extractor, `name`/`slug` mapping, next-page signal, reliable completeness and error variants | If safe extraction or truthfully calculated `truncated` is impossible, revise R2 projection and obtain independent review; **no G4** |
| **P-03** | **G2** | Exactly one approved workspace slug, immutable Git commit-pinned Owner decision evidence + SHA-256, organization linkage, and acceptance of first-page max25 behavior; source literal and required runtime `BITBUCKET_WORKSPACE_SLUG` must be independently cross-checked | Missing/mismatched slug/ref/hash/env, revoked approval or syntax violation → virtual tool disabled; no fallback, never assume `diamondhead` |
| **P-04** | **G1** | Exact Rovo permission-denial error structure (to distinguish -32052 from generic failures) | Until proven, publish only the generic sanitized failure; do not claim ACL classification |
| **P-05** | **G3** | Bridge OAuth principal's effective Rovo Bitbucket read permission without extracting or modifying credentials | Missing read grant/denial means no auth expansion and no runtime authorization |
| **P-06** | **G1/G2** | Portal accepts zero-argument external contract; precise metadata, tool-list pagination and workspace binding cannot be bypassed; distinguish schema-only from authorized runtime workspace scoping evidence | If Portal needs additional input or Rovo ignores workspace filters, return to design review, not silent relaxation; metadata-only ⇒ runtime NOT_PROVEN |

**Counterexamples with mandatory outcomes:**
1. If the upstream operation cannot be **reliably restricted to the approved workspace**, the fixed-workspace invariant is **NOT_MET**. Neither returned-data filtering after an all-workspace fetch nor a best-effort query string is a sufficient replacement; block implementation.
2. If a real Rovo response does not allow unambiguous derivation of the chosen normalized fields (`name`, `slug`), the published output contract is **NOT_READY**. Redesign/independent re-review before implementation.
3. On new schema variants, unknown error codes or unexpected pagination representation, **fail closed**; no implicit fallback to old public Tunnel, generic `discover`/`executeRead`, REST endpoint or wider OAuth scope.
4. If a first-page-only result cannot support accurate `truncated` semantics, do not publish a misleading false/empty result. Require contract revision.
5. If any pending field cannot be resolved, **G1/G2/G3 remain PENDING; code implementation is prohibited**.

## 6. Separated governance: design versus later implementation/release

Approval phases are **independent**; evidence or authorization in one phase cannot substitute for another.

| Phase | Gate | State now | Required outcome |
|---|---|---|---|
| **Baseline** | G0 | **PASS** | Merged master baseline and three CI jobs verified |
| **Contract and runtime evidence** | G1 | **PENDING / NOT_RUNTIME_PROVEN** | Apply `4.6` G1-01–07 evidence matrix. Static descriptor establishes advertised contracts only; workspace isolation and actual result behavior require pre-existing approved H or a future separately authorized L. No such new invocation authorized here. |
| **Owner workspace decision** | G2 | **PENDING** | Approve exact fixed slug and immutable decision ref/hash, org linkage and one-page behavior. Verify separately pinned Worker literal and runtime env equality before any future deployment. |
| **Effective permission evidence** | G3 | **PENDING** | Sanitary read-permission classification for the actual Bridge principal; no secret/token exposure or new OAuth grant |
| **Design review and approval** | D-GATE | **PENDING** | Reviewer confirms R2 coherence and Pending Decisions are hard stops; Owner decides design adoption |
| **PR #3 Ready/merge (DESIGN ONLY)** | D-MERGE | **PENDING** | D-GATE passed, exact document-only diff, Owner explicitly authorizes Ready and merge. May merge with G1–G3 still pending **only if** implementation stays blocked and no unknown upstream contract is misrepresented as fixed |
| **Implementation authorization** | I-AUTH | **NOT_STARTED** | G1, G2, G3 resolved as required; P-01/P-02/P-03/P-05/P-06 closed; any remaining P-04 must use generic failures; contract freeze independently reviewed; Owner explicitly authorizes code changes on a **later implementation PR** |
| **Implementation work** | G4 | **NOT_STARTED** | Core one-slot extension + Worker-only mapper, no broad refactor |
| **Implementation testing and review** | G5 + I-REVIEW | **NOT_STARTED** | Node 20/22 and Docker CI, malicious-input/permission/ID/error/bounds tests; independent source diff review; Owner decides acceptance |
| **Deployment authorization** | DEP-AUTH | **NOT_STARTED** | Explicit separate Owner authorization to deploy after I-REVIEW; no CI auto-deploy |
| **Controlled runtime** | G6 + R-ACCEPT | **NOT_STARTED** | Owner-controlled deployment; ChatGPT Portal verifies exactly 3 advertised tools, fixed-workspace limited success, existing two metadata tools unaffected, no write paths; sanitized evidence + rollback proof |
| **Implementation merge** | G7 / I-MERGE | **NOT_STARTED** | Owner authorizes implementation PR merge **after** review/runtime acceptance as agreed; cannot inherit design PR approval |

**PR #3 is documentation-only.** Neither implementation review, deployment, nor runtime acceptance is a prerequisite to *design-only* merge. Conversely, design merge alone grants **zero** implementation, permission-escalation, deployment or production-use authorization. G1–G3 may remain Pending at D-MERGE, but I-AUTH cannot pass without the pending schema/workspace/auth evidence and reviewed completion of the exact contract.

## 7. Test policy and non-functional requirements for the *future* implementation

**Offline contract tests, later implementation PR only:**
- Approved Worker literal vs required `BITBUCKET_WORKSPACE_SLUG`: missing, empty, casing, whitespace, Unicode, invalid syntax, swapped decision ref/hash, different slug, revoked/changed decision, flag `on` or non-VPC mode → virtual tool never advertised or dispatched, metadata tools preserved, direct virtual call `503/-32050` with zero upstream calls; independently assert fixed code ref and decision evidence match under G2.
- G1-01–07 evidence fixtures: accept only version-pinned exact schema; reject forged/partial nested inputs, fabricated result variants, ambiguous `name`/`slug`, unknown cursor/`truncated`, cross-workspace data, misleading permission errors. Mocked tests show only implementation behavior, **not** live Rovo evidence.
- Non-200 classification table `4.6`: 1xx, 200, 201/202/204/206, 3xx, 400/401/403/404/408/409/422/429/other4xx, 500/503/other5xx, invalid status, network exception, timeout and HTTP200 JSON-RPC errors all checked without forwarding upstream data.

- `tools/list` valid first page yields metadata tools plus exactly one virtual tool; cursor page adds zero virtual entries; invalid upstream format, SSE, oversized list, collision or duplicate fail closed. Cross-page filtering never leaks generic read/write tools.
- Valid explicit empty args → one upstream internal `executeRead` with literal `listBitbucketRepositories` and **only** schema-pinned workspace-scoped `inputs`; strict response ID equality; exactly one synthesized `CallToolResult`.
- Missing/extra/array/null arguments, caller-controlled workspace, cloudId, operation/input/URL/cursor, malformed JSON-RPC, batch/notification and unrelated names → fixed denial and **zero upstream calls**.
- Generic `discover`, `executeRead`, `executeWrite` and `executeDestructive` remain denied with `ATLASSIAN_UNVERIFIED_READ_TOOLS=off`; an internal call does not mutate the outer allowlist or publish the internal tool.
- Wrong Portal Bearer, missing/invalid Relay Bearer, missing VPC Service, invalid workspace config, unauthorized Rovo response, invalid content type/redirect, 401/403/5xx, unexpected `CallToolResult`, JSON-RPC `id` mismatch, schema drift and oversize → exact sanitized classification; never leak secrets or fallback.
- First-page `next` signal, over25 items, exactly25 items with/without next, no next, output encoding/byte overage and erroneous claims of `truncated=false` are covered by pinned G1 fixtures.
- Existing metadata tools' authentication, response filtering and ordinary `initialize`/`ping`/`notifications`/`GET`/`DELETE` remain unchanged. No new public route or OAuth behavior.

**Non-functional gates:** bounded memory (256 KiB inbound / 256 KiB virtual upstream / 64 KiB serialized virtual output), max25 entries, max30s per virtual request, no automatic retries; preserve existing Free-plan compatibility, one fixed VPC destination, confidential token boundary, no raw repo or auth data in logs, and single-user identity limitation. CI must use synthetic fixtures with zero Atlassian/Bitbucket/OAuth/Cloudflare live operations. Operator deployment and Portal synchronization require later explicit authorization; rollback targets the last **verified VPC version**, never the Bot-Fight-challenged public route.

**Design/plan consistency:** no independent implementation plan exists at R2. Therefore **no document-to-plan alignment test is possible yet**. Before I-AUTH, require a separate reviewed implementation plan that reproduces: this versioned specification, `VirtualToolSpec` type boundaries, Pending Decision closures, exact external and internal contracts, error codes, bounds, regression tests and non-functional ceilings. Any conflict = **I-AUTH BLOCKED**. This task does **not** create that plan.

## 8. Finding resolution and change log

| Finding | R2 revision | Status |
|---|---|---|
| **R1-FND-001 (Major/High)** | Retains one `createMcpRelay` slot; R2.1 adds literal Owner-approved slug/decision ref/hash in Worker source, required independent `BITBUCKET_WORKSPACE_SLUG` runtime binding, Core strict validation at tools/list/call and reapproval on change. | **RESOLVED_IN_DESIGN_R2_1**; workspace actual approval G2 PENDING |
| **R1-FND-002 (Major/High)** | Keeps R2 contract and limits; adds G1-01–07 evidence source/method/PASS/BLOCKED matrix, static-vs-runtime proof separation and exhaustive non-200 HTTP mapping. | **RESOLVED_IN_DESIGN_R2_1_WITH_PENDING_G1_EVIDENCE**; real schema/data/workspace behavior NOT_PROVEN |
| **R1-FND-003 (Minor/High)** | D-GATE/D-MERGE separation from implementation and deployment remains unchanged. | **RESOLVED_IN_DESIGN_R2 (MAINTAINED)**; decisions unapproved |

**R2.1 limited diff (R2 → R2.1):** specified immutable Owner workspace decision ref/hash + Worker literal, required runtime env binding, Core equality/syntax checks and reapproval on changes; added G1-01–07 structured proof acquisition/decision matrix with strict runtime-vs-static separation and complete HTTP 1xx–5xx/transport exception mapping; expanded future test obligations; R1-FND-003 governance distinction unchanged. **No new Rovo field asserted, no source/test/config change.**

**Historical diff summary (R1 → R2):** fixed the previously optional architecture choice; introduced one narrow Core extension type and exact dispatch boundaries; selected external schema and bounded normalized output; specified internal RPC construction, ID check, fail-closed validation order, byte/time/page limits and error taxonomy; enumerated source-dependent Pending Decisions and falsification gates; split design approval/merge from later implementation/deployment/runtime acceptance. No change to production or existing two published tools.

## 9. R2.1 conclusion

**Design R2.1 = READY_FOR_INDEPENDENT_DESIGN_REVIEW, NOT IMPLEMENTATION_READY.** G0 remains PASS. **G1, G2, G3, D-GATE and D-MERGE are PENDING; G4 onward, I-AUTH, DEP-AUTH and R-ACCEPT are NOT_STARTED.** This document does not itself establish source proof for the actual Rovo operation schema, authorize OAuth/Cloudflare changes, approve an Owner decision, permit live Bitbucket access, or authorize any source modification, deployment or PR merge.
