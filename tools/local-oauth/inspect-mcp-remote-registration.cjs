#!/usr/bin/env node
/**
 * Read-only local inspector for mcp-remote 0.14.3 persisted client_info.json.
 * Do not read token files, write credentials, or output arbitrary saved fields.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.MCP_REMOTE_CONFIG_DIR;
const emit = value => process.stdout.write(JSON.stringify(value,null,2)+'\n');
if (!root) {
  emit({result:'environment_not_configured'});
  process.exitCode = 2;
} else {
  const dir=path.join(root,'mcp-remote-v1');
  let files;
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw Error('not_directory');
    files=fs.readdirSync(dir,{withFileTypes:true})
      .filter(entry=>entry.isFile() && entry.name.endsWith('_client_info.json'))
      .map(entry=>entry.name).sort();
  } catch {
    emit({result:'registration_directory_unavailable'});
    process.exitCode=2;
  }
  if(files) {
    if(files.length>10) {
      emit({result:'too_many_registration_records',record_count:files.length});
      process.exitCode=2;
    } else {
      const records=files.map((file,index)=>{
        try {
          const location=path.join(dir,file);
          if(fs.statSync(location).size>65536) throw Error('oversized');
          const o=JSON.parse(fs.readFileSync(location,'utf8'));
          if(!o || typeof o!=='object' || Array.isArray(o)) throw Error('invalid_json_object');
          const grants=Array.isArray(o.grant_types)?o.grant_types:null;
          const types=Array.isArray(o.response_types)?o.response_types:null;
          const uris=Array.isArray(o.redirect_uris)?o.redirect_uris:null;
          const scopes=typeof o.scope==='string'?o.scope.split(/\s+/).filter(Boolean):null;
          const auth=o.token_endpoint_auth_method;
          const loopbacks=uris?.map(value=>{
            if(typeof value!=='string') return false;
            try {
              const u=new URL(value);
              return u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname);
            } catch {return false;}
          });
          const callbacks=uris?.map(value=>{
            if(typeof value!=='string')return false;
            try {return ['/callback','/oauth/callback'].includes(new URL(value).pathname);}
            catch{return false;}
          });
          return {
            number:index+1,result:'record_parsed',
            client_id_present:typeof o.client_id==='string'&&o.client_id.length>0,
            client_id_uses_metadata_document:typeof o.client_id==='string'&&o.client_id.startsWith('https://'),
            client_secret_present:typeof o.client_secret==='string'&&o.client_secret.length>0,
            issuer_field_present:typeof o.issuer==='string',
            issuer_is_atlassian_identity:typeof o.issuer==='string'&&o.issuer.startsWith('https://auth.atlassian.com/'),
            client_uri_field_present:typeof o.client_uri==='string',
            software_id_field_present:typeof o.software_id==='string',
            software_version_field_present:typeof o.software_version==='string',
            grants_reported:grants!==null,
            authorization_code_grant_reported:grants===null?null:grants.includes('authorization_code'),
            refresh_token_grant_reported:grants===null?null:grants.includes('refresh_token'),
            code_response_type_reported:types===null?null:types.includes('code'),
            token_endpoint_auth_method:['none','client_secret_post','client_secret_basic'].includes(auth)?auth:'NOT_REPORTED_OR_OTHER',
            redirect_uris_reported:uris!==null,
            redirect_uri_count:uris===null?null:uris.length,
            redirect_all_loopback:loopbacks===undefined?null:loopbacks.every(Boolean),
            redirect_has_expected_callback_path:callbacks===undefined?null:callbacks.some(Boolean),
            scope_reported:scopes!==null,
            scope_count:scopes===null?null:scopes.length,
            bitbucket_read_scope_reported:scopes===null?null:scopes.includes('read:bitbucket:agent-interface'),
            mutating_scopes_reported:scopes===null?null:scopes.some(s=>/^(write|delete|manage):/.test(s)),
          };
        } catch {return {number:index+1,result:'invalid_registration_record'};}
      });
      emit({
        result:files.length?'persisted_registration_inspection':'no_registration_records',
        source:'mcp-remote-v1_persisted_client_info_only',
        note:'Only selected classifications. Missing stored fields do not prove missing fields in DCR POST.',
        record_count:files.length,records,
      });
    }
  }
}
