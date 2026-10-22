import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMcpRelay} from '@mcp-bridge/core';
import worker from '../src/index.mjs';
import {bitbucketVirtualTool} from '../src/bitbucket.mjs';

const bearer='p'.repeat(48), relay='r'.repeat(48);
const workspace='example-workspace';
const rpc=(method,params,id=10)=>({jsonrpc:'2.0',id,method,params});
const request=(body)=>new Request('https://bridge.example/mcp',{method:'POST',
  headers:{authorization:'Bearer '+bearer,'content-type':'application/json'},
  body:JSON.stringify(body)});
const env=(fetcher,overrides={})=>({
  PORTAL_BEARER_TOKEN:bearer,LOCAL_RELAY_BEARER_TOKEN:relay,
  ATLASSIAN_UPSTREAM_MODE:'local_relay_vpc',ATLASSIAN_UNVERIFIED_READ_TOOLS:'off',
  ATLASSIAN_RELAY_VPC:{fetch:fetcher},...overrides,
});
const jsonRpc=(id,values)=>new Response(JSON.stringify({jsonrpc:'2.0',id,
  result:{content:[{type:'text',text:JSON.stringify(values)}]}}),{
    headers:{'content-type':'application/json'},
  });
async function invoke(spec,environment,body) {
  const response=await spec.fetch(request(body),environment);
  return {status:response.status,body:await response.json()};
}
const names=['listBitbucketWorkspaces','listBitbucketRepositories'];
test('no workspace slug is configured in source or Wrangler config',()=>{
  const config=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(Object.hasOwn(config.vars,'BITBUCKET_WORKSPACE_SLUG'),false);
  assert.equal(Object.hasOwn(bitbucketVirtualTool,'workspaceBinding'),false);
  assert.equal(config.vars.ATLASSIAN_UPSTREAM_MODE,'local_relay_vpc');
  assert.equal(config.vars.ATLASSIAN_UNVERIFIED_READ_TOOLS,'off');
  assert.equal(config.vpc_services[0].binding,'ATLASSIAN_RELAY_VPC');
  assert.deepEqual(config.secrets.required,['PORTAL_BEARER_TOKEN','LOCAL_RELAY_BEARER_TOKEN']);
  const workflow=readFileSync(new URL('../../../.github/workflows/deploy-atlassian.yml',import.meta.url),'utf8');
  assert.doesNotMatch(workflow,/BITBUCKET_WORKSPACE_SLUG/);
});
test('metadata shows exactly two dedicated reads, not generic executeRead',async()=>{
  let calls=0;
  const transport=async(_url,opts)=>{
    calls++;
    const req=JSON.parse(new TextDecoder().decode(opts.body));
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{
      tools:[{name:'executeRead'},{name:'executeWrite'},
        {name:'atlassianUserInfo'},{name:'getAccessibleAtlassianResources'}],
      nextCursor:'next'}}),{headers:{'content-type':'application/json'}});
  };
  const first=await invoke(worker,env(transport),rpc('tools/list',{},1));
  assert.equal(first.status,200);
  assert.deepEqual(first.body.result.tools.map(t=>t.name),[
    'atlassianUserInfo','getAccessibleAtlassianResources',...names]);
  assert.deepEqual(first.body.result.tools[2].inputSchema,{
    type:'object',properties:{},additionalProperties:false});
  assert.deepEqual(first.body.result.tools[3].inputSchema.required,['workspaceId']);
  assert.equal(first.body.result.nextCursor,'next');
  const next=await invoke(worker,env(transport),rpc('tools/list',{cursor:'next'},2));
  assert.deepEqual(next.body.result.tools.map(t=>t.name),[
    'atlassianUserInfo','getAccessibleAtlassianResources']);
  assert.equal(calls,2);
});
test('workspace list uses current relay OAuth session, no external workspace value',async()=>{
  let calls=0;
  const transport=async(url,opts)=>{
    calls++; assert.equal(url,'http://127.0.0.1/mcp');
    assert.equal(opts.headers.get('authorization'),'Bearer '+relay);
    assert.equal(opts.headers.get('cf-access-client-id'),null);
    assert.equal(opts.redirect,'manual');
    assert.deepEqual(JSON.parse(opts.body),rpc('tools/call',{
      name:'executeRead',arguments:{name:'listBitbucketWorkspaces',inputs:{}},
    },3));
    return jsonRpc(3,{values:[{slug:workspace},{workspace:{slug:'other-workspace'}}],nextPage:true});
  };
  const out=await invoke(worker,env(transport),rpc('tools/call',{
    name:'listBitbucketWorkspaces',arguments:{}},3));
  assert.equal(out.status,200);
  assert.deepEqual(JSON.parse(out.body.result.content[0].text),{
    schemaVersion:1,workspaces:[{slug:workspace},{slug:'other-workspace'}],truncated:true});
  assert.equal(calls,1);
});
test('live-observed text.json.data.values shape returns only OAuth workspace slugs',async()=>{
  const upstream=async()=>jsonRpc(14,{
    data:{values:[{uuid:'{synthetic-workspace-uuid}',slug:workspace}]},
  });
  const response=await invoke(worker,env(upstream),rpc('tools/call',{
    name:'listBitbucketWorkspaces',arguments:{},
  },14));
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(response.body.result.content[0].text),{
    schemaVersion:1,
    workspaces:[{slug:workspace}],
    truncated:false,
  });
  assert.equal(JSON.stringify(response.body).includes('synthetic-workspace-uuid'),false);
});
test('repository list uses explicit workspaceId, OAuth still decides authorization',async()=>{
  let calls=0;
  const transport=async(url,opts)=>{
    calls++; assert.equal(url,'http://127.0.0.1/mcp');
    assert.deepEqual(JSON.parse(opts.body),rpc('tools/call',{
      name:'executeRead',arguments:{
        name:'listBitbucketRepositories',inputs:{workspaceId:workspace,page:1,pagelen:25}},
    },4));
    return jsonRpc(4,{values:[{name:'Repo',full_name:workspace+'/repo'}],nextPage:true});
  };
  const out=await invoke(worker,env(transport),rpc('tools/call',{
    name:'listBitbucketRepositories',arguments:{workspaceId:workspace}},4));
  assert.equal(out.status,200);
  assert.deepEqual(JSON.parse(out.body.result.content[0].text),{
    schemaVersion:1,workspace,repositories:[{name:'Repo',slug:'repo'}],truncated:true});
  assert.equal(calls,1);
});
test('rejects invalid or caller-controlled generic tool inputs before upstream',async()=>{
  let calls=0;
  const e=env(async()=>{calls++;throw Error('unexpected upstream');});
  for (const p of [
    {name:'listBitbucketRepositories',arguments:{}},
    {name:'listBitbucketRepositories',arguments:{workspaceId:'x',page:2}},
    {name:'listBitbucketRepositories',arguments:{workspaceId:'UPPER'}},
    {name:'listBitbucketRepositories',arguments:{workspaceId:'../../other'}},
    {name:'listBitbucketRepositories',arguments:{workspaceId:null}},
    {name:'listBitbucketWorkspaces',arguments:{workspaceId:workspace}},
    {name:'listBitbucketWorkspaces',arguments:[]},
    {name:'listBitbucketWorkspaces'},
  ]) {
    const r=await invoke(worker,e,rpc('tools/call',p,5));
    assert.equal(r.status,400);
  }
  for (const name of ['executeRead','discover','executeWrite','executeDestructive']) {
    const r=await invoke(worker,e,rpc('tools/call',{name,arguments:{}},6));
    assert.equal(r.status,403);
  }
  assert.equal(calls,0);
});
test('no VPC, unsafe mode and mismatched portal credentials fail closed',async()=>{
  let calls=0;
  const transport=async()=>{calls++;throw Error('unexpected upstream');};
  for (const changes of [
    {ATLASSIAN_UNVERIFIED_READ_TOOLS:'on'},
    {ATLASSIAN_UPSTREAM_MODE:'direct'},
  ]) {
    for (const name of names) {
      const r=await invoke(worker,env(transport,changes),rpc('tools/call',{
        name,arguments:name===names[0]?{}:{workspaceId:workspace},
      },7));
      assert.equal(r.status,503);
    }
  }
  const absent=await invoke(worker,env(transport,{ATLASSIAN_RELAY_VPC:undefined}),
    rpc('tools/call',{name:names[0],arguments:{}},7));
  assert.equal(absent.status,503);
  const wrong=await worker.fetch(new Request('https://bridge.example/mcp',{
    method:'POST',headers:{authorization:'Bearer '+'x'.repeat(48),'content-type':'application/json'},
    body:JSON.stringify(rpc('tools/call',{name:names[0],arguments:{}},7)),
  }),env(transport));
  assert.equal(wrong.status,401);
  assert.equal(calls,0);
});
test('upstream authorization denial and workspace mismatch cannot leak data',async()=>{
  const access=await invoke(worker,env(async()=>new Response('secret',{status:403})),
    rpc('tools/call',{name:names[1],arguments:{workspaceId:workspace}},8));
  assert.equal(access.status,502);
  assert.equal(access.body.error.code,-32051);
  assert.equal(JSON.stringify(access.body).includes('secret'),false);
  const mismatch=await invoke(worker,env(async()=>jsonRpc(9,{
    values:[{name:'Private',full_name:'some-other-workspace/private'}],
  })),rpc('tools/call',{name:names[1],arguments:{workspaceId:workspace}},9));
  assert.equal(mismatch.status,502);
  assert.equal(mismatch.body.error.code,-32054);
});
test('workspace response rejects invalid page metadata, unknown shape and oversized body',async()=>{
  for (const data of [
    {values:[{slug:workspace}],nextPage:1},
    {values:[{slug:'INVALID'}]},
    {values:[{no_slug:true}]},
    {values:[],next:123},
  ]) {
    const out=await invoke(worker,env(async()=>jsonRpc(11,data)),
      rpc('tools/call',{name:names[0],arguments:{}},11));
    assert.equal(out.status,502);
    assert.equal(out.body.error.code,-32054);
  }
  const huge=await invoke(worker,env(async()=>jsonRpc(12,{
    values:[{slug:'x'.repeat(270000)}],
  })),rpc('tools/call',{name:names[0],arguments:{}},12));
  assert.equal(huge.status,502);
});
test('upstream virtual tool name collision fails closed',async()=>{
  const out=await invoke(worker,env(async()=>new Response(JSON.stringify({
    jsonrpc:'2.0',id:13,result:{tools:[{name:'listBitbucketWorkspaces'}]},
  }),{headers:{'content-type':'application/json'}})),rpc('tools/list',{},13));
  assert.equal(out.status,502);
});
