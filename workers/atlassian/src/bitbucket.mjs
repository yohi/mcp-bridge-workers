// A single allowlisted deferred read; NO caller-selected operation or workspace.
// This module has no fetch, token access or OAuth capability.
const MAX_REPOSITORIES = 25;
const MAX_NAME_BYTES = 256;
const MAX_SLUG_BYTES = 128;
const byteLength = s => new TextEncoder().encode(s).length;
const plainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// Fixed workspace is selected by source and must match the independent
// BITBUCKET_WORKSPACE_SLUG Worker variable. No caller can choose a workspace.
export const bitbucketVirtualTool = Object.freeze({
  publicName: 'listBitbucketRepositories',
  description: 'List up to 25 repositories from the fixed Bitbucket workspace (first page only).',
  inputSchema: {type:'object',properties:{},additionalProperties:false},
  internalToolName: 'executeRead',
  internalOperationName: 'listBitbucketRepositories',
  workspaceBinding: Object.freeze({
    slug: 'diamondhead',
    envKey: 'BITBUCKET_WORKSPACE_SLUG',
  }),
  buildInputs: ({workspace}) => ({workspaceId:workspace,page:1,pagelen:MAX_REPOSITORIES}),
  normalize: (result,{workspace}) => {
    if (!plainObject(result) || result.isError === true) throw Error('bad_result');
    const candidates = [result.structuredContent,result];
    if (result.content !== undefined) {
      if (!Array.isArray(result.content) || result.content.length > 4) throw Error('bad_content');
      for (const item of result.content) {
        if (!plainObject(item) || item.type !== 'text' || typeof item.text !== 'string') {
          throw Error('bad_content');
        }
        try { candidates.push(JSON.parse(item.text)); }
        catch {throw Error('unparseable_content');}
      }
    }
    const pages=[];
    for (const candidate of candidates) {
      if (!plainObject(candidate)) continue;
      if (Array.isArray(candidate.values) || Array.isArray(candidate.repositories)) {
        pages.push(candidate);
      } else if (plainObject(candidate.data) &&
                 (Array.isArray(candidate.data.values) ||
                  Array.isArray(candidate.data.repositories))) {
        pages.push(candidate.data);
      }
    }
    if (pages.length !== 1) throw Error('ambiguous_page_shape');
    const data = pages[0];
    const rows = Array.isArray(data.values) ? data.values : data.repositories;
    if (!Array.isArray(rows)) throw Error('bad_repositories');
    if (!(data.next === undefined || data.next === null ||
          typeof data.next === 'string')) throw Error('bad_pagination');
    if (typeof data.next === 'string' && data.next.length > 4096) {
      throw Error('bad_pagination');
    }
    if (data.nextPage !== undefined && typeof data.nextPage !== 'boolean') {
      throw Error('bad_pagination');
    }
    const repositories = rows.slice(0,MAX_REPOSITORIES).map(r => {
      if (!plainObject(r) || typeof r.name !== 'string' ||
          r.name.length === 0 || byteLength(r.name) > MAX_NAME_BYTES ||
          typeof r.full_name !== 'string') throw Error('invalid_repository');
      const segments = r.full_name.split('/');
      if (segments.length !== 2 || segments[0] !== workspace ||
          !segments[1] || byteLength(segments[1]) > MAX_SLUG_BYTES) {
        throw Error('workspace_or_schema_mismatch');
      }
      return {name:r.name,slug:segments[1]};
    });
    // No continuation URL or raw upstream object can escape this projection.
    return {
      schemaVersion:1,workspace,repositories,
      truncated:rows.length > MAX_REPOSITORIES || Boolean(data.next) || data.nextPage === true,
    };
  },
});
