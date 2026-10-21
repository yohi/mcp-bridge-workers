import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.mjs';

test('Atlassian MCP upstream is pinned to v2 (Bitbucket support)', async () => {
  const previousFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({url: String(url), method: options.method});
    return new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: {
      tools: [{name:'executeRead'},{name:'executeDestructive'}],
    }}), {
      headers: {'content-type': 'application/json'},
    });
  };
  try {
    const result = await worker.fetch(new Request('https://bridge.invalid/mcp', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + 'p'.repeat(48),
        'content-type': 'application/json',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    }), {
      PORTAL_BEARER_TOKEN: 'p'.repeat(48),
      UPSTREAM_AUTHORIZATION: 'Bearer ' + 'a'.repeat(48),
    });
    assert.equal(result.status, 200);
    // The v2 upstream remains fixed, but unverified nested read operations
    // must not be visible by default in the finalization policy.
    assert.deepEqual((await result.json()).result.tools, []);
    const optedIn = await worker.fetch(new Request('https://bridge.invalid/mcp', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + 'p'.repeat(48),
        'content-type': 'application/json',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    }), {
      PORTAL_BEARER_TOKEN: 'p'.repeat(48),
      UPSTREAM_AUTHORIZATION: 'Bearer ' + 'a'.repeat(48),
      ATLASSIAN_UNVERIFIED_READ_TOOLS: 'on',
    });
    assert.equal(optedIn.status, 200);
    assert.deepEqual((await optedIn.json()).result.tools, [{name:'executeRead'}]);
    assert.deepEqual(seen, [{
      url: 'https://mcp.atlassian.com/v2/mcp',
      method: 'POST',
    }, {
      url: 'https://mcp.atlassian.com/v2/mcp',
      method: 'POST',
    }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
