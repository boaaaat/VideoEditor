import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('a real stdio client authenticates through the loopback bridge and receives errors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'video-editor-mcp-'));
  const token = 'b'.repeat(64);
  const received = [];
  const http = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    received.push(request);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(request.method === 'command.execute' ? { error: 'Fixture track is locked' } : { result: { project: { name: 'Stdio fixture' } } }));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const configPath = join(dir, 'bridge.json');
  await writeFile(configPath, JSON.stringify({ url: `http://127.0.0.1:${http.address().port}/rpc`, token }));
  const client = new Client({ name: 'stdio-regression', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], env: { ...process.env, AI_VIDEO_EDITOR_BRIDGE_FILE: configPath }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await new Promise((resolve) => http.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const state = await client.callTool({ name: 'editor_state', arguments: {} });
  assert.equal(state.structuredContent.project.name, 'Stdio fixture');
  const failed = await client.callTool({ name: 'delete_clip', arguments: { clipId: 'c1' } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /locked/);
  assert.equal(received.length, 2);
});
