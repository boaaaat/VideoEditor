import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEditorMcpServer, editingCommandSchema } from '../src/server.mjs';
import { validateBridgeConfig } from '../src/bridge.mjs';

async function connected(t, rpc) {
  const server = createEditorMcpServer(rpc);
  const client = new Client({ name: 'regression-client', version: '1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('MCP initialization discovers editing tools, resources, and prompts', async (t) => {
  const client = await connected(t, async (method) => ({ method, project: { name: 'Fixture' } }));
  const { tools } = await client.listTools();
  for (const name of ['editor_state', 'media_import', 'timeline_frame', 'edit_batch', 'apply_transform', 'export_start', 'propose_edits']) assert.ok(tools.some((tool) => tool.name === name));
  assert.equal(tools.find((tool) => tool.name === 'editor_state').annotations.readOnlyHint, true);
  const { resources } = await client.listResources();
  assert.equal(resources.length, 3);
  const read = await client.readResource({ uri: 'video-editor://timeline' });
  assert.equal(JSON.parse(read.contents[0].text).method, 'timeline.state');
  const { prompts } = await client.listPrompts();
  assert.equal(prompts[0].name, 'edit_video');
});

test('timeline frame returns image content, defaults size, and validates before dispatch', async (t) => {
  const calls = [];
  const client = await connected(t, async (method, params) => {
    calls.push({method,params});
    return {dataUrl:'data:image/png;base64,aGVsbG8=',timeUs:33333,width:640,height:360,cached:false};
  });
  const frame = await client.callTool({name:'timeline_frame',arguments:{timeUs:33333}});
  assert.deepEqual(calls,[{method:'timeline.frame',params:{timeUs:33333,maxWidth:1280}}]);
  assert.equal(frame.content[0].type,'image');
  assert.equal(frame.content[0].mimeType,'image/png');
  assert.equal(JSON.parse(frame.content.find(item=>item.type==='text').text).timeUs,33333);
  for (const args of [{timeUs:-1},{timeUs:1.5},{maxWidth:0},{maxWidth:8192}]) {
    assert.equal((await client.callTool({name:'timeline_frame',arguments:args})).isError,true);
  }
  assert.equal(calls.length,1);
});

test('compound tools dispatch once and preserve source timing and effects', async (t) => {
  const calls = [];
  const client = await connected(t, async (method, params) => { calls.push({ method, params }); return { ok: true }; });
  const commands = [
    { type: 'add_clip', mediaId: 'm1', clipId: 'c1', trackId: 'v1', startUs: 0, inUs: 1_000_000, outUs: 3_000_000, speedPercent: 200, color: { brightness: 10 }, transform: { opacity: 0.5 } },
    { type: 'apply_audio_adjustment', clipId: 'c1', adjustment: { gainDb: -6, fadeInUs: 500_000 } }
  ];
  const result = await client.callTool({ name: 'edit_batch', arguments: { commands, label: 'Fixture edit' } });
  assert.ok(!result.isError);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'command.execute', params: { type: 'execute_batch', commands, label: 'Fixture edit' } });
});

test('media recovery and temporary projects retain MCP arguments and safety hints', async (t) => {
  const calls=[];
  const client=await connected(t,async(method,params)=>{calls.push({method,params});return {ok:true};});
  const {tools}=await client.listTools();
  assert.equal(tools.find(tool=>tool.name==='media_check').annotations.readOnlyHint,true);
  assert.equal(tools.find(tool=>tool.name==='media_relink').annotations.readOnlyHint,false);
  await client.callTool({name:'media_check',arguments:{}});
  await client.callTool({name:'media_relink',arguments:{mediaId:'m1',path:'C:/moved/café 日本.mp4'}});
  await client.callTool({name:'project_create',arguments:{path:'C:/fixture',name:'Temporary',remember:false}});
  await client.callTool({name:'project_open',arguments:{path:'C:/fixture',remember:false}});
  assert.deepEqual(calls,[
    {method:'media.check',params:{}},
    {method:'command.execute',params:{type:'relink_media',mediaId:'m1',path:'C:/moved/café 日本.mp4'}},
    {method:'project.create',params:{path:'C:/fixture',name:'Temporary',remember:false}},
    {method:'project.open',params:{path:'C:/fixture',remember:false}}
  ]);
  const invalid=await client.callTool({name:'media_relink',arguments:{mediaId:'m1',path:''}});
  assert.equal(invalid.isError,true);assert.equal(calls.length,4);
  const fades={fadeInUs:2000000,fadeOutUs:2000000,fadeOffsetUs:1000000,fadeDurationUs:4000000};
  const command={type:'add_clip',mediaId:'m1',trackId:'v1',startUs:0,audio:fades,transform:fades};
  assert.deepEqual(editingCommandSchema.parse(command),command);
});

test('invalid times, speed, unknown fields and nested operations are rejected before dispatch', async (t) => {
  let called = false;
  const client = await connected(t, async () => { called = true; return {}; });
  const result = await client.callTool({ name: 'move_clip', arguments: { clipId: 'c1', trackId: 'v1', startUs: -1 } });
  assert.equal(result.isError, true);
  assert.equal(called, false);
  assert.equal(editingCommandSchema.safeParse({ type: 'execute_batch', commands: [] }).success, false);
  assert.equal(editingCommandSchema.safeParse({ type: 'apply_clip_speed', clipId: 'c1', speedPercent: 0 }).success, false);
  assert.equal(editingCommandSchema.safeParse({ type: 'delete_clip', clipId: 'c1', arbitrary: true }).success, false);
});

test('engine failures are tool errors and source frames become MCP image content', async (t) => {
  const client = await connected(t, async (method) => {
    if (method === 'media.frame') return { dataUrl: 'data:image/png;base64,aGVsbG8=', mediaId: 'm1' };
    throw new Error('Track is locked');
  });
  const failed = await client.callTool({ name: 'delete_clip', arguments: { clipId: 'c1' } });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /locked/);
  const frame = await client.callTool({ name: 'media_frame', arguments: { mediaId: 'm1', timeUs: 0 } });
  assert.equal(frame.content[0].type, 'image');
  assert.equal(frame.content[0].mimeType, 'image/png');
});

test('bridge config cannot redirect agent credentials off the local endpoint', () => {
  const token = 'a'.repeat(64);
  assert.equal(validateBridgeConfig({ url: 'http://127.0.0.1:47112/rpc', token }).token, token);
  for (const url of ['http://example.com:47112/rpc', 'http://localhost:47112/rpc', 'http://127.0.0.1:47112/other', 'http://user:pass@127.0.0.1:47112/rpc', 'http://127.0.0.1:47112/rpc?token=abc']) assert.throws(() => validateBridgeConfig({ url, token }));
  assert.throws(() => validateBridgeConfig({ url: 'http://127.0.0.1:47112/rpc', token: '' }));
});

test('plugin tools route scopes and parameters and leave proposal application separate', async (t) => {
  const calls = [];
  const client = await connected(t, async (method, params) => { calls.push({method,params}); return {proposal:{id:'pending'}}; });
  const output = await client.callTool({name:'plugin_run',arguments:{pluginId:'example.markers',parameters:{prefix:'Chapter',count:3,enabled:true}}});
  assert.ok(!output.isError);
  assert.deepEqual(calls,[{method:'plugin.run',params:{pluginId:'example.markers',scope:'project',parameters:{prefix:'Chapter',count:3,enabled:true}}}]);
  assert.equal((await client.callTool({name:'plugins_list',arguments:{scope:'external'}})).isError,true);
  assert.equal((await client.callTool({name:'plugin_run',arguments:{pluginId:'example.markers',parameters:{bad:{nested:true}}}})).isError,true);
  assert.equal(calls.length,1);
  await client.callTool({name:'plugin_enable',arguments:{pluginId:'example.markers',scope:'user',enabled:false}});
  assert.deepEqual(calls[1],{method:'plugin.enable',params:{pluginId:'example.markers',scope:'user',enabled:false}});
});
