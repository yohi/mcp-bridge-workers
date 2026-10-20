# Local OAuth feasibility (not an authentication implementation)

\`check-oauth-discovery.mjs\` reads official Atlassian OAuth metadata without creating clients, logging in, fetching tokens, or changing resources.

\`\`\`bash
npm run check:atlassian-oauth
\`\`\`

\`check-localhost-redirect.mjs\` is a separate, **explicitly opted-in** localhost experiment. Only run it on a local machine after confirming organizational permission:

\`\`\`bash
node tools/local-oauth/check-localhost-redirect.mjs --register
\`\`\`

It attempts one Dynamic Client Registration (DCR) and displays a browser authorization URL. If consent returns a code on loopback with the right state, it discards the code and reports the callback. **No token exchange or Worker handoff occurs.** Do not post authorization URLs or callback URLs containing \`code\` to GitHub or ChatGPT.

See [the full verification protocol](../../docs/oauth-feasibility.md) before running.
