import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { VERSION } from './version';

const VIEWER_URI = 'ui://csv-viewer/table.html';
const html = readFileSync(new URL('./viewer.html', import.meta.url), 'utf8');
const server = new McpServer({ name: 'csv-viewer', version: VERSION });

registerAppResource(server, 'CSV table viewer', VIEWER_URI, {
  description: 'Read-only table interface for the CSV opened by the user.',
  _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
}, async () => ({
  contents: [{
    uri: VIEWER_URI,
    mimeType: RESOURCE_MIME_TYPE,
    text: html,
    _meta: {
      ui: { csp: { connectDomains: [], resourceDomains: [] } },
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' },
    },
  }],
}));

registerAppTool(server, 'open_csv', {
  title: 'CSV 表格查看器',
  description: 'View the opened CSV file as a searchable, sortable table. Read-only; does not convert, upload, or modify the source file.',
  inputSchema: {
    file: z.object({ name: z.string().min(1), resourceUri: z.string().min(1) }),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  _meta: {
    ui: { resourceUri: VIEWER_URI, visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.csv'] }] },
  },
}, async () => ({ content: [] }));

await server.connect(new StdioServerTransport());
