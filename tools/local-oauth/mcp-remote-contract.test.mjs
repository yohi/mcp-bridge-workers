import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const root=new URL('./',import.meta.url);
const read=path=>readFileSync(new URL(path,root),'utf8');
const compose=read('compose.mcp-remote.yaml');
const image=read('Dockerfile.mcp-remote');
const metadata=JSON.parse(read('bitbucket-readonly-client.json'));

test('mcp-remote OAuth metadata pins only Bitbucket read without broader access',()=>{
  assert.deepEqual(metadata,{scope:'read:bitbucket:agent-interface'});
  assert.equal(Object.hasOwn(metadata,'grant_types'),false);
  assert.equal(Object.hasOwn(metadata,'token_endpoint_auth_method'),false);
  assert.equal(Object.hasOwn(metadata,'client_id'),false);
  assert.equal(Object.hasOwn(metadata,'client_secret'),false);
});
test('isolated local OAuth uses published pinned version with non-root runtime',()=>{
  assert.match(image,/npm install --global --omit=dev mcp-remote@0\.14\.3/);
  assert.match(image,/^USER node$/m);
  assert.match(compose,/image: mcp-bridge-atlassian-auth:0\.14\.3/);
  assert.match(compose,/profiles: \[auth\]/);
  assert.match(compose,/entrypoint: \["mcp-remote-client"\]/);
  assert.match(compose,/MCP_REMOTE_CONFIG_DIR: \/home\/node\/\.mcp-auth/);
});
test('same v2 endpoint and callback semantics as successful tunnel, but non-conflicting local port',()=>{
  assert.match(compose,/https:\/\/mcp\.atlassian\.com\/v2\/mcp/);
  assert.match(compose,/network_mode: host/);
  assert.match(compose,/- "38678"/);
  assert.match(compose,/- localhost/);
  assert.match(compose,/- \/oauth\/callback/);
  assert.match(compose,/- http-only/);
  assert.match(compose,/- --static-oauth-client-metadata/);
  assert.match(compose,/- "@\/etc\/mcp-bridge\/bitbucket-readonly-client\.json"/);
  assert.doesNotMatch(compose,/--authorize-param|prompt=consent|--skip-resource/);
});
test('credential isolation and no cloud/legacy token handoff',()=>{
  assert.match(compose,/atlassian-oauth-cache:\/home\/node\/\.mcp-auth/);
  assert.match(compose,/bitbucket-readonly-client\.json:\/etc\/mcp-bridge\/bitbucket-readonly-client\.json:ro/);
  assert.match(compose,/read_only: true/);
  assert.match(compose,/cap_drop: \[ALL\]/);
  assert.match(compose,/no-new-privileges:true/);
  assert.doesNotMatch(compose,/CONTROL_PLANE_API_KEY|UPSTREAM_AUTHORIZATION|PORTAL_BEARER_TOKEN|wrangler|cloudflare/);
});
