/**
 * Minimal HTTP -> stdio MCP relay for a *locally cached* mcp-remote OAuth session.
 * No tokens are read by this HTTP process. Never log requests or responses.
 * Only bind loopback: cloudflared on the same Linux host provides TLS ingress.
 */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const MAX_BYTES=262144;
const MAX_LINE_BYTES=2097152;
const MAX_PENDING=32;
const ALLOWED_METHODS=new Set(['initialize','notifications/initialized',
  'notifications/cancelled','ping','tools/list','tools/call']);
const reply=(res,status,data)=> {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
};
const eq=(a,b)=> {
  if(typeof a!=='string'||typeof b!=='string'||b.length<32) return false;
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
};
export function makeHandler({rpc,secret}) {
  return async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(pathname==='/health'&&req.method==='GET') {
        return reply(res,200,{status:'alive',upstreamConnected:'not_verified'});
      }
      if(pathname!=='/mcp') return reply(res,404,{error:'not_found'});
      const supplied=req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if(!eq(supplied,secret)) return reply(res,401,{error:'unauthorized'});
      if(req.method!=='POST') return reply(res,405,{error:'method_not_allowed'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) {
        return reply(res,415,{error:'unsupported_media_type'});
      }
      let chunks=[],total=0;
      for await(const part of req){
        total+=part.length;
        if(total>MAX_BYTES)return reply(res,413,{error:'payload_too_large'});
        chunks.push(part);
      }
      let msg;
      try{msg=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
      catch{return reply(res,400,{error:'invalid_json'});}
      if(!msg||typeof msg!=='object'||Array.isArray(msg)||
          msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||!ALLOWED_METHODS.has(msg.method)){
        return reply(res,403,{error:'method_not_allowed'});
      }
      if(msg.method==='tools/call'&&
          (!msg.params||typeof msg.params.name!=='string')){
        return reply(res,400,{error:'invalid_tool_call'});
      }
      if(!Object.hasOwn(msg,'id')){
        await rpc.notify(msg);
        res.writeHead(202,{'cache-control':'no-store'});return res.end();
      }
      if(typeof msg.id!=='string'&&typeof msg.id!=='number'){
        return reply(res,400,{error:'invalid_request_id'});
      }
      const result=await rpc.call(msg);
      reply(res,200,result);
    }catch{
      if(!res.headersSent)reply(res,502,{error:'local_mcp_unavailable'});
      else res.destroy();
    }
  };
}

/** Rewrites JSON-RPC IDs so parallel HTTP clients cannot collide. */
export class StdioRpc {
  constructor(child) {
    this.child=child;this.buffer='';this.pending=new Map();this.dead=false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>this.receive(chunk));
    child.on('exit',()=>{
      this.dead=true;
      for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(Error('closed'));}
      this.pending.clear();
    });
    child.on('error',()=>{this.dead=true;});
  }
  receive(chunk){
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>MAX_LINE_BYTES){this.child.kill();return;}
    let cut;
    while((cut=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,cut);this.buffer=this.buffer.slice(cut+1);
      if(!line.trim())continue;
      let msg;try{msg=JSON.parse(line);}catch{continue;}
      if(!msg||!Object.hasOwn(msg,'id'))continue;
      const task=this.pending.get(msg.id);if(!task)continue;
      this.pending.delete(msg.id);clearTimeout(task.timer);
      msg.id=task.originalId;
      task.resolve(msg);
    }
  }
  async notify(msg){
    if(this.dead||!this.child.stdin.writable)throw Error('unavailable');
    if(!this.child.stdin.write(JSON.stringify(msg)+'\n')) {
      await new Promise((resolve,reject)=>{
        this.child.stdin.once('drain',resolve);this.child.stdin.once('error',reject);
      });
    }
  }
  async call(msg){
    if(this.dead||this.pending.size>=MAX_PENDING)throw Error('unavailable');
    const internalId=randomUUID(),originalId=msg.id;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(internalId);reject(Error('timeout'));
      },60000);
      this.pending.set(internalId,{originalId,resolve,reject,timer});
      this.notify({...msg,id:internalId}).catch(()=>{
        clearTimeout(timer);this.pending.delete(internalId);reject(Error('unavailable'));
      });
    });
  }
}

async function main(){
  if(!process.env.RELAY_SECRET_FILE)throw Error('secret_not_configured');
  let secret;
  try {
    secret=readFileSync(process.env.RELAY_SECRET_FILE,'utf8').trim();
  }catch {
    throw Error('secret_not_readable');
  }
  if(secret.length<32)throw Error('secret_too_short');
  const args=['https://mcp.atlassian.com/v2/mcp','38678','--transport',
    'http-only','--host','localhost','--auth-timeout','180'];
  const child=spawn(process.execPath,[
    '/usr/local/lib/node_modules/mcp-remote/dist/proxy.js',...args,
  ],{stdio:['pipe','pipe','ignore'],env:{
    HOME:process.env.HOME,
    MCP_REMOTE_CONFIG_DIR:process.env.MCP_REMOTE_CONFIG_DIR,
  }});
  const rpc=new StdioRpc(child);
  const server=http.createServer(makeHandler({rpc,secret}));
  server.listen(18787,'127.0.0.1');
  const shutdown=()=>{server.close();child.kill('SIGTERM');};
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  child.on('exit',()=>{server.close();process.exitCode=1;});
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    // Never print raw exception details: they may contain environment/paths.
    const safeCodes=new Set(['secret_not_configured','secret_not_readable','secret_too_short']);
    const code=safeCodes.has(error?.message)?error.message:'startup_failed';
    process.stderr.write('MCP_RELAY_STARTUP_FAILED: '+code+'\n');
    process.exitCode=1;
  });
}
