import {createMcpRelay} from '@mcp-bridge/core';

// Provider-specific configuration stays in the dedicated Worker.
// Tool names and semantics still require verification with the live Rovo MCP.
export default createMcpRelay({
  name: 'atlassian-rovo-mcp-bridge',
  upstreamUrl: 'https://mcp.atlassian.com/v2/mcp',
  allowedTools: ['atlassianUserInfo','getAccessibleAtlassianResources','discover','executeRead'],
});
