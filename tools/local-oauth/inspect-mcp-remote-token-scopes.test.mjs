import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=path.join(path.dirname(fileURLToPath(import.meta.url)),'inspect-mcp-remote-token-scopes.cjs');
function fixture(fn){
  const root=mkdtempSync(path.join(tmpdir(),'scope-inspector-'));
  try{
    const dir=path.join(root,'mcp-remote-v1');mkdirSync(dir);
    const run=()=>spawnSync(process.execPath,[script],{
      env:{...process.env,MCP_REMOTE_CONFIG_DIR:root},encoding:'utf8',timeout:3000
    });
    return fn({dir,run});
  }finally{rmSync(root,{recursive:true,force:true});}
}
test('only scope classifications, no raw credentials or scope names',()=>fixture(({dir,run})=>{
  writeFileSync(path.join(dir,'SECRET_FILENAME_tokens.json'),JSON.stringify({
    access_token:'SECRET_ACCESS',refresh_token:'SECRET_REFRESH',issuer:'https://auth.atlassian.com/SECRET_ISSUER',
    requested_scope:'read:me read:account read:bitbucket:agent-interface write:jira:agent-interface SECRET_SCOPE',
    scope:'read:me offline_access read:bitbucket:agent-interface'
  }));
  const p=run();assert.equal(p.status,0,p.stderr);
  for(const value of ['SECRET_FILENAME','SECRET_ACCESS','SECRET_REFRESH','SECRET_ISSUER','SECRET_SCOPE','write:jira:agent-interface']){
    assert.equal(p.stdout.includes(value),false);
  }
  const result=JSON.parse(p.stdout);
  assert.equal(result.record_count,1);
  assert.deepEqual(result.records[0].requested_scope,{
    present:true,scope_count:5,read_me:true,read_account:true,offline_access:false,
    bitbucket_read:true,jira_read:false,confluence_read:false,contains_mutating_scopes:true
  });
  assert.equal(result.records[0].granted_scope.offline_access,true);
  assert.equal(result.records[0].granted_scope.contains_mutating_scopes,false);
}));
test('missing server-provided scope does not infer denial',()=>fixture(({dir,run})=>{
  writeFileSync(path.join(dir,'h_tokens.json'),JSON.stringify({
    access_token:'SECRET_ACCESS',requested_scope:'read:bitbucket:agent-interface'
  }));
  const result=JSON.parse(run().stdout);
  assert.equal(result.records[0].requested_scope.bitbucket_read,true);
  assert.deepEqual(result.records[0].granted_scope,{present:false});
}));
test('no cache does not trigger login or file creation',()=>fixture(({run})=>{
  const result=JSON.parse(run().stdout);
  assert.equal(result.result,'no_token_records');
  assert.equal(result.record_count,0);
}));
test('bad JSON is sanitized',()=>fixture(({dir,run})=>{
  writeFileSync(path.join(dir,'h_tokens.json'),'{SENSITIVE_BAD_JSON');
  const p=run();assert.equal(p.status,0);
  assert.equal(JSON.parse(p.stdout).records[0].result,'scope_metadata_unavailable');
  assert.equal(p.stdout.includes('SENSITIVE_BAD_JSON'),false);
}));
test('explicit configuration directory required',()=>{
  const p=spawnSync(process.execPath,[script],{env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(p.status,2);
  assert.equal(JSON.parse(p.stdout).result,'environment_not_configured');
});
