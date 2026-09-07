import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.mjs';
import { createEditorMcpServer } from './server.mjs';

const server = createEditorMcpServer(createBridge());
await server.connect(new StdioServerTransport());
