# Inspect the successful mcp-remote DCR registration locally

Purpose: Compare the OAuth registration metadata saved by the already-working chatgpt-mcp-tunnel to the new mcp-bridge-workers DCR probe, without copying credentials or requesting new OAuth registrations.

Source: chatgpt-mcp-tunnel currently pins mcp-remote v0.14.3 and mounts its OAuth volume at /home/node/.mcp-auth. Upstream v0.14.3 stores the cached client registration under mcp-remote-v1/*_client_info.json. Such files may contain client secrets or registration credentials: NEVER upload/copy or print their raw content.

## Run on the trusted Linux Docker host

The following commands assume sibling repositories, as in the existing local setup. This runs the Node script via stdin inside a temporary Compose container; it replaces the authentication entrypoint, does not invoke mcp-remote, does not run OAuth or DCR, and does not write to the volume.

~~~bash
cd ~/program/private/mcp-bridge-workers
git pull
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
