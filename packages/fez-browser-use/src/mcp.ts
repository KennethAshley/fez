import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { browserUseSessionFile, createBrowserUseServer } from './index.js';

await createBrowserUseServer({ sessionFile: browserUseSessionFile({
  sessionFile: process.env.FEZ_BROWSER_USE_SESSION?.trim() || process.env.FEZ_COMPUTER_USE_SESSION,
  persona: process.env.FEZ_AGENT_PERSONA,
}) }).connect(new StdioServerTransport());
