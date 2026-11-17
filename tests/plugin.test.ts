import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

async function withPackagedPlugin(run: (client: Client) => Promise<void>) {
  // Exercise the installed manifest's command, args and cwd. Launching the bundle
  // directly hides invalid placeholders or relative paths in .mcp.json.
  const pluginRoot = fileURLToPath(new URL('../plugins/csv-viewer/', import.meta.url));
  const config = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers['csv-viewer'];
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: path.resolve(pluginRoot, config.cwd ?? '.'),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'csv-viewer-verification', version: '1.0.0' });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

test('packaged startup configuration launches the CSV file handler and a read-only UI resource', async () => {
  await withPackagedPlugin(async client => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1, 'The plugin must not expose file-write or general filesystem tools.');
    const tool = tools[0];
    assert.equal(tool.name, 'open_csv');
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.deepEqual(tool._meta?.['openai/ui'], { entrypoints: [{ type: 'file', extensions: ['.csv'] }] });
    const ui = tool._meta?.ui as { resourceUri: string };
    const resource = await client.readResource({ uri: ui.resourceUri });
    assert.equal(resource.contents.length, 1);
    const content = resource.contents[0];
    assert.equal(content.mimeType, 'text/html;profile=mcp-app');
    assert.ok('text' in content && content.text.includes('CSV'));
    const result = await client.callTool({ name: 'open_csv', arguments: { file: { name: 'sample.csv', resourceUri: 'host-resource://read-only-test' } } });
    assert.deepEqual(result.content, []);
  });
});

test('opening the public fictional CSV preserves its original hash and file size', async () => {
  const source = new URL('../examples/sample.csv', import.meta.url);
  const bytesBefore = await readFile(source);
  const hashBefore = createHash('sha256').update(bytesBefore).digest('hex');
  await withPackagedPlugin(async client => {
    const result = await client.callTool({
      name: 'open_csv',
      arguments: { file: { name: 'sample.csv', resourceUri: source.href } },
    });
    assert.deepEqual(result.content, []);
  });
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), hashBefore);
  assert.equal((await stat(source)).size, bytesBefore.length);
});
