import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Pass `codex mcp get video-editor --json` on stdin to check the exact
// registered runtime and bundle. Without the flag, check the source server.
let launch = { command: process.execPath, args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))] };
if (process.argv.includes('--codex-config-stdin')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input.replace(/^\uFEFF/, ''));
  assert.equal(config.enabled, true, 'The Codex server is disabled');
  assert.equal(config.transport.type, 'stdio', 'Expected a stdio MCP server');
  launch = config.transport;
}
const transport = new StdioClientTransport({
  command: launch.command, args: launch.args, env: launch.env,
  ...(launch.cwd ? { cwd: launch.cwd } : {}), stderr: 'pipe',
});
transport.stderr.on('data', (chunk) => process.stderr.write(chunk));
const client = new Client({ name: 'video-editor-readonly-check', version: '1.0.0' });
const options = { timeout: 25000 };
const report = {};

function payload(result) {
  assert.ok(!result.isError, result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') || 'MCP tool failed');
  return result.structuredContent ?? JSON.parse(result.content.find((item) => item.type === 'text').text);
}
async function call(name, args = {}) {
  return payload(await client.callTool({ name, arguments: args }, undefined, options));
}
function passed(step, details = {}) { console.log(JSON.stringify({ step, ...details, ok: true })); }

try {
  await client.connect(transport, { timeout: 20000 });
  report.server = client.getServerVersion();
  passed('MCP handshake', { server: report.server });
  const tools = (await client.listTools({}, options)).tools;
  for (const name of ['editor_state', 'timeline_state', 'media_list', 'media_check', 'history']) {
    assert.ok(tools.some((tool) => tool.name === name && tool.annotations?.readOnlyHint === true), `Missing read-only tool ${name}`);
  }
  report.tools = tools.length;
  report.resources = (await client.listResources({}, options)).resources.map((item) => item.uri);
  report.prompts = (await client.listPrompts({}, options)).prompts.map((item) => item.name);
  assert.ok(report.resources.includes('video-editor://timeline'));
  const prompt = await client.getPrompt({ name: 'edit_video', arguments: { goal: 'Inspect the current project without making changes.' } }, options);
  assert.ok(prompt.messages.length);
  passed('Discovery', { tools: report.tools, resources: report.resources.length, prompts: report.prompts.length });

  const state = await call('editor_state');
  report.project = {
    name: state.project?.name, open: Boolean(state.project?.path),
    media: state.mediaAssets?.length ?? 0, tracks: state.timeline?.tracks?.length ?? 0,
    clips: state.timeline?.clips?.length ?? 0, contentDurationUs: state.contentDurationUs,
  };
  passed('Live editor state', report.project);
  const before = await call('history');
  const timeline = await call('timeline_state');
  assert.ok(timeline && Array.isArray(timeline.tracks));
  const media = await call('media_list');
  assert.ok(Array.isArray(media.media));
  const availability = await call('media_check');
  report.missingMedia = availability.missingCount;
  for (const uri of report.resources) {
    const read = await client.readResource({ uri }, options);
    assert.ok(read.contents?.length);
    for (const content of read.contents) if (content.text) JSON.parse(content.text);
  }
  passed('Live tools and resources', { missingMedia: report.missingMedia });

  if (state.project?.path && state.contentDurationUs > 0) {
    const timeUs = Math.max(0, Math.min(state.playheadUs ?? 0, state.contentDurationUs - 1));
    const result = await client.callTool({ name: 'timeline_frame', arguments: { timeUs, maxWidth: 640 } }, undefined, { timeout: 30000 });
    assert.ok(!result.isError, result.content?.find((item) => item.type === 'text')?.text);
    const frame = result.content.find((item) => item.type === 'image');
    assert.ok(frame && frame.mimeType.startsWith('image/'));
    const bytes = Buffer.from(frame.data, 'base64');
    assert.ok(bytes.length > 100, 'Frame image is empty');
    report.frame = { mimeType: frame.mimeType, bytes: bytes.length, timeUs };
    passed('Composed frame', report.frame);
  } else report.frame = { skipped: 'No open project with timeline content' };

  const after = await call('history');
  assert.deepEqual(after, before, 'Undo history changed during read-only checks');
  report.historyUnchanged = true;
  console.log(JSON.stringify({ result: 'PASS', ...report }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', message: error.message, completed: report }));
  process.exitCode = 1;
} finally { await client.close(); }
