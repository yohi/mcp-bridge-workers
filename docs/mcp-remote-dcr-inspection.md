# Inspect the successful mcp-remote DCR registration locally

Purpose: Compare the OAuth registration metadata saved by the already-working chatgpt-mcp-tunnel to the new mcp-bridge-workers DCR probe, without copying credentials or requesting new OAuth registrations.

Source: chatgpt-mcp-tunnel currently pins mcp-remote v0.14.3 and mounts its OAuth volume at /home/node/.mcp-auth. Upstream v0.14.3 stores the cached client registration under mcp-remote-v1/*_client_info.json. Such files may contain client secrets or registration credentials: NEVER upload/copy or print their raw content.

## Run on the trusted Linux Docker host

The following commands assume sibling repositories, as in the existing local setup. This runs the Node script via stdin inside a temporary Compose container; it replaces the authentication entrypoint, does not invoke mcp-remote, does not run OAuth or DCR, and does not write to the volume.

~~~bash
cd ~/program/private/mcp-bridge-workers
git pull
npm install --ignore-scripts --no-audit --no-fund
npm test

cd ../chatgpt-mcp-tunnel
docker compose --profile auth run --rm -T --no-deps \
  --entrypoint node auth - \
  < ../mcp-bridge-workers/tools/local-oauth/inspect-mcp-remote-registration.cjs
~~~

The inspector has no network calls. It reads only the cache files ending in _client_info.json, never any tokens.json, verifier or session files. It emits whitelisted booleans and counts, the recognized client authentication method, and sanitized status codes. It will NOT reveal client_id, client_secret, registration access tokens, raw URLs, callback ports, issuer tenant identifiers or full scope lists. Do not add logging of raw objects or errors.

A missing/false result is NOT proof that a parameter was absent from the original DCR POST: cached registration responses often omit properties. In particular, absent grants or scopes in client_info.json must not be treated as proof of absent grants or scopes in a registration request.

If the result is environment_not_configured, registration_directory_unavailable or no_registration_records, stop: do not remove the Docker volume and do not initiate a new login to manufacture diagnostic evidence.

The printed, sanitized JSON may be shared for analysis. Do not share the raw client info files, Docker volume or authorization URLs.

Unit tests with synthetic secrets:
~~~bash
node --test tools/local-oauth/inspect-mcp-remote-registration.test.mjs
~~~

No actual DCR request, token exchange or Cloudflare Worker deployment has been performed. Bridge consent remains NOT PROVEN and the PR stays Draft until an authorized, successful localhost callback is observed.

## Operator-run sanitized result (2026-10-20, JST)

The owner ran the exact read-only Docker Compose inspector against the **previously successful** `yohi/chatgpt-mcp-tunnel` OAuth volume. Its output reported **one** persisted registration record with `record_parsed`. Only these already-sanitized classifications are preserved; no secrets, client ID values, raw redirect URLs, scope strings, registration responses, or tokens were submitted.

| Observed field | Value | Interpretation |
| --- | --- | --- |
| `client_id_present` | `true` | An actual non-URL client identifier was persisted |
| `client_id_uses_metadata_document` | `false` | This is not a Client ID Metadata Document identifier |
| `client_secret_present` | `true` | Atlassian-provided secret exists **even though** the method is `none` |
| `issuer_is_atlassian_identity` | `true` | Persisted issuer matches the expected Identity host prefix |
| `token_endpoint_auth_method` | `none` | **Successful precedent** for public-client mode alongside an unused secret |
| `redirect_uris_reported`, `redirect_uri_count`, `redirect_all_loopback` | `true`, `1`, `true` | One loopback URI persisted |
| `redirect_has_expected_callback_path` | `true` | Standard callback path seen |
| `grants_reported`, `scope_reported` | `false`, `false` | **Unknown**, not disproved: persisted *response* does not disclose original DCR *request* |
| `authorization_code_grant_reported`, `refresh_token_grant_reported` | `null`, `null` | Unknown; do not infer grants are absent or present |
| `bitbucket_read_scope_reported`, `mutating_scopes_reported` | `null`, `null` | Unknown; does not justify adding elevated scopes |
| `client_uri_field_present`, `software_id_field_present`, `software_version_field_present` | `false`, `false`, `false` | These were not present in the stored registration **response**, which says nothing about request inclusion |

**Decision:** The earlier Bridge defect that rejected *any* `client_secret` was already corrected by `registration-result.mjs`: it now accepts a valid `none` public-client registration and never logs, uses or persists the secret. The success-side evidence supports keeping this behavior. It **does not** explain Bridge's separate post-consent `invalid_request` or prove current Bridge's OAuth grant succeeds. Do **not** add `refresh_token`, `client_uri`, `software_id`, extra permissions or change the client authentication method solely based on the absent cached fields. Keep PR #2 Draft. A single approved follow-up consent probe with only the already-staged `prompt=consent` change could discriminate one hypothesis; no retest or new registration occurred during this inspection.
