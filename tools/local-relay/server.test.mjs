import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {makeHandler,StdioRpc} from './server.mjs';

const secret='s'.repeat(48);
const serve=async(fn)=>{
 const rpc={calls:[],notes:[],async call(msg){this.calls.push(msg);return {jsonrpc:'2.0',id:msg.id,result:{tools:[]}};},
 async notify(msg){this.notes.push(msg);}};
 const s=http.createServer(makeHandler({rpc,secret}));
 await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
 try{await fn({rpc,url:'http://127.0.0.1:'+s.address().port});}
 finally{await new Promise(resolve=>s.close(resolve));}
};
const post=(url,body,token=secret,extras={})=>fetch(url+'/mcp',{
 method:'POST',headers:{'content-type':'application/json',
 ...(token?{authorization:'Bearer '+token}:{}),...extras},
 body:JSON.stringify(body)
});
const req=(method,id=1,params)=>({jsonrpc:'2.0',method,id,params});
test('child process receives only allowlisted environment and a fixed PATH',()=>{
 const source=readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
 assert.match(source,/env:\{\s*HOME:process\.env\.HOME,\s*MCP_REMOTE_CONFIG_DIR:process\.env\.MCP_REMOTE_CONFIG_DIR,\s*PATH:'\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'/);
 assert.doesNotMatch(source,/env:\{\.\.\.process\.env/);
});
test('unauthorized HTTP denied before any RPC invocation',()=>serve(async({rpc,url})=>{
 const r=await post(url,req('tools/list'),null);assert.equal(r.status,401);
 assert.equal(rpc.calls.length,0);
 const bad=await post(url,req('tools/list'),'x'.repeat(48));
 assert.equal(bad.status,401);assert.equal(rpc.calls.length,0);
}));
test('valid JSON-RPC roundtrip with id unchanged',()=>serve(async({rpc,url})=>{
 const r=await post(url,req('tools/list','caller-1'));
 assert.equal(r.status,200);
 const j=await r.json();assert.equal(j.id,'caller-1');
 assert.equal(rpc.calls.length,1);
}));
test('notification 202 and no response body',()=>serve(async({rpc,url})=>{
 const r=await post(url,{jsonrpc:'2.0',method:'notifications/initialized'});
 assert.equal(r.status,202);assert.equal(await r.text(),'');
 assert.equal(rpc.notes.length,1);
}));
test('health gives no credentials or claimed OAuth connection',()=>serve(async({url})=>{
 const r=await fetch(url+'/health');assert.equal(r.status,200);
 const x=await r.json();assert.equal(x.upstreamConnected,'not_verified');
 assert.equal(JSON.stringify(x).includes(secret),false);
}));
test('reject unsupported JSON RPC methods and payloads',()=>serve(async({rpc,url})=>{
 for(const body of [req('prompts/get'),req('resources/read'),[req('initialize')],{oops:true}]){
   const r=await post(url,body);assert.equal(r.status,403);
 }
 assert.equal(rpc.calls.length,0);
}));
test('incoming caller credential or upstream URL cannot alter relay',()=>serve(async({rpc,url})=>{
 const r=await fetch(url+'/mcp?target=https://invalid.example',{
 method:'POST',
 headers:{'content-type':'application/json',authorization:'Bearer '+secret,
   cookie:'sensitive','x-upstream-auth':'secret'},
 body:JSON.stringify(req('ping'))
 });
 assert.equal(r.status,200);assert.equal(rpc.calls.length,1);
 assert.equal(rpc.calls[0].method,'ping');
}));
test('stdio remaps request IDs and returns original without collision',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();
 child.stdin=new PassThrough();
 const rpc=new StdioRpc(child);
 const writes=[];child.stdin.on('data',x=>writes.push(JSON.parse(x.toString())));
 const a=rpc.call(req('tools/list',5)),b=rpc.call(req('ping',5));
 assert.equal(writes.length,2);
 assert.notEqual(writes[0].id,writes[1].id);
 child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:writes[1].id,result:{pong:true}})+'\n');
 child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:writes[0].id,result:{tools:[]}})+'\n');
 assert.equal((await a).id,5);assert.equal((await b).id,5);
 child.emit('exit');
});
test('stdio fatal exit rejects in-flight requests',async()=>{
 const child=new EventEmitter();child.stdout=new PassThrough();
 child.stdin=new PassThrough();const rpc=new StdioRpc(child);
 const p=rpc.call(req('ping',1));child.emit('exit');
 await assert.rejects(p,/closed/);
});

test('startup failure reports only a safe code, never secret paths or values',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const filename=fileURLToPath(new URL('./server.mjs',import.meta.url));
 const invalid='/secret-path-SENSITIVE-not-found';
 const run=spawnSync(process.execPath,[filename],{
   env:{...process.env,RELAY_SECRET_FILE:invalid},
   encoding:'utf8',timeout:3000
 });
 assert.equal(run.status,1);
 assert.match(run.stderr,/MCP_RELAY_STARTUP_FAILED: secret_not_readable/);
 assert.doesNotMatch(run.stderr,/SENSITIVE|\/secret-path|atlant|access_token|refresh_token/);
 assert.equal(run.stdout,'');
});
