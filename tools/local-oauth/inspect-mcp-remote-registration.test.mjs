import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'inspect-mcp-remote-registration.cjs');
function fixture(fn) {
  const dir=mkdtempSync(path.join(tmpdir(),'mcp-remote-inspector-'));
  try {
    const cache=path.join(dir,'mcp-remote-v1');mkdirSync(cache);
    const run=()=>spawnSync(process.execPath,[script],{env:{...process.env,MCP_REMOTE_CONFIG_DIR:dir},encoding:'utf8',timeout:3000});
    return fn(cache,run);
  } finally {rmSync(dir,{force:true,recursive:true});}
}
test('secret, identifiers, full URLs and tokens are never printed',()=>fixture((dir,run)=>{
  const obj={
    client_id:'SENSITIVE_CLIENT_ID',client_secret:'SENSITIVE_SECRET',registration_access_token:'SENSITIVE_REG_TOKEN',
    grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',
    redirect_uris:['http://localhost:38677/oauth/callback?private=SENSITIVE_QUERY'],
    issuer:'https://auth.atlassian.com/SENSITIVE_ISSUER',
    scope:'read:bitbucket:agent-interface write:jira:agent-interface'
  };
  writeFileSync(path.join(dir,'abc_client_info.json'),JSON.stringify(obj));
  writeFileSync(path.join(dir,'abc_tokens.json'),'SENSITIVE_ACCESS_TOKEN');
  const p=run();assert.equal(p.status,0,p.stderr);
  for (const term of ['SENSITIVE_CLIENT_ID','SENSITIVE_SECRET','SENSITIVE_REG_TOKEN','SENSITIVE_QUERY','SENSITIVE_ISSUER','SENSITIVE_ACCESS_TOKEN'])
    assert.equal(p.stdout.includes(term),false);
  const d=JSON.parse(p.stdout);
  assert.equal(d.records[0].refresh_token_grant_reported,true);
  assert.equal(d.records[0].bitbucket_read_scope_reported,true);
  assert.equal(d.records[0].mutating_scopes_reported,true);
}));
test('empty registration folder does not read token files',()=>fixture((dir,run)=>{
  writeFileSync(path.join(dir,'abc_tokens.json'),'PRIVATE_TOKEN');
  const p=run();assert.equal(p.status,0);
  assert.equal(JSON.parse(p.stdout).result,'no_registration_records');
  assert.ok(!p.stdout.includes('PRIVATE_TOKEN'));
}));
test('invalid registration is sanitized',()=>fixture((dir,run)=>{
  writeFileSync(path.join(dir,'abc_client_info.json'),'{SENSITIVE_BAD_JSON');
  const p=run();assert.equal(p.status,0);
  assert.equal(JSON.parse(p.stdout).records[0].result,'invalid_registration_record');
  assert.ok(!p.stdout.includes('SENSITIVE_BAD_JSON'));
}));
test('requires an explicit configuration directory',()=>{
  const p=spawnSync(process.execPath,[script],{env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(p.status,2);
  assert.equal(JSON.parse(p.stdout).result,'environment_not_configured');
});
