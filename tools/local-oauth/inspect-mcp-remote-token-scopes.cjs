#!/usr/bin/env node
/**
 * LOCAL read-only mcp-remote v0.14.3 saved-token scope inspection.
 * No network, writes, token or raw scope output.
 */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const emit=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
function summary(value){
  if(typeof value!=='string')return {present:false};
  const values=value.trim().split(/\s+/).filter(Boolean);
  const has=x=>values.includes(x);
  return {
    present:true,
    scope_count:values.length,
    read_me:has('read:me'),
    read_account:has('read:account'),
    offline_access:has('offline_access'),
    bitbucket_read:has('read:bitbucket:agent-interface'),
    jira_read:has('read:jira:agent-interface'),
    confluence_read:has('read:confluence:agent-interface'),
    contains_mutating_scopes:values.some(x=>/^(write|delete|manage):/.test(x))
  };
}
const root=process.env.MCP_REMOTE_CONFIG_DIR;
if(!root){
  emit({result:'environment_not_configured'});
  process.exitCode=2;
}else{
  const directory=path.join(root,'mcp-remote-v1');
  let files;
  try{
    if(!fs.lstatSync(directory).isDirectory())throw Error('invalid_directory');
    files=fs.readdirSync(directory,{withFileTypes:true})
      .filter(x=>x.isFile()&&x.name.endsWith('_tokens.json')).map(x=>x.name).sort();
  }catch{
    emit({result:'token_directory_unavailable'});
    process.exitCode=2;
  }
  if(files){
    if(files.length>10){
      emit({result:'too_many_token_records'});
      process.exitCode=2;
    }else{
      const records=files.map((name,index)=>{
        try{
          const file=path.join(directory,name);
          if(fs.statSync(file).size>65536)throw Error('oversized');
          const obj=JSON.parse(fs.readFileSync(file,'utf8'));
          if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('invalid_token_record');
          return {
            number:index+1,
            result:'scope_metadata_parsed',
            requested_scope:summary(obj.requested_scope),
            granted_scope:summary(obj.scope)
          };
        }catch{
          return {number:index+1,result:'scope_metadata_unavailable'};
        }
      });
      emit({
        result:files.length?'persisted_scope_metadata_inspection':'no_token_records',
        source:'mcp-remote-v1_saved_token_metadata_only',
        note:'Only safe scope classifications. Missing granted scope does not prove missing permissions. No login or DCR.',
        record_count:files.length,records
      });
    }
  }
}
