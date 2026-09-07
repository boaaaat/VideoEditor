// Explicit desktop integration test; creates only synthetic projects and packages.
import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = resolve(root, 'engine/build', `mcp-plugins-${Date.now()}`);
await mkdir(directory, { recursive: true });
const client = new Client({ name: 'live-plugin-check', version: '1.0' });
await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/index.mjs',import.meta.url))],stderr:'pipe'}));
const checks = [];
async function call(name, args = {}, expectError = false) {
  if (name === 'project_create' || name === 'project_open') args = {...args,remember:false};
  const result = await client.callTool({name,arguments:args},undefined,{timeout:130_000});
  if (expectError) { assert.equal(result.isError,true,JSON.stringify(result)); checks.push(`${name}: rejected`); return result; }
  assert.ok(!result.isError, JSON.stringify(result)); checks.push(name);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function fixture(id, source, permissions = []) {
  const folder = join(directory, id);
  await mkdir(folder);
  await writeFile(join(folder,'plugin.json'),JSON.stringify({id,name:id,version:'1',type:'typescript',entry:'main.js',permissions}));
  await writeFile(join(folder,'main.js'),source);
  await call('plugin_install',{folder});
  await call('plugin_enable',{pluginId:id,enabled:true});
  return folder;
}
let networkRequests = 0;
const server = createServer((request,response) => { networkRequests++; response.setHeader('Access-Control-Allow-Origin','*'); response.end('fixture'); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
try {
  for (let attempt=0;attempt<30;attempt++) { const result=await client.callTool({name:'editor_state',arguments:{}}); if (!result.isError) break; await delay(200); }
  assert.ok(!(await call('editor_state')).project.path,'Use a fresh editor for this test.');
  await call('project_create',{path:join(directory,'project'),name:'Plugin integration check'});
  const mediaPath = join(directory,'fixture.mp4');
  const generated = spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error','-f','lavfi','-i','color=c=blue:s=640x360:r=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p',mediaPath],{encoding:'utf8',windowsHide:true});
  assert.equal(generated.status,0,generated.stderr);
  await call('media_import',{paths:[mediaPath]});
  const media=(await call('media_list')).media[0];
  await call('add_clip',{clipId:'plugin-clip',mediaId:media.id,trackId:'v1',startUs:0,outUs:2_000_000});
  const initial=await call('timeline_state');
  const packageFolder=join(root,'examples/plugins/clip-markers');
  const inspected=await call('plugin_inspect',{folder:packageFolder});
  assert.equal(inspected.manifest.id,'example.clip-markers');
  await call('plugin_install',{folder:packageFolder});
  await call('plugin_run',{pluginId:'example.clip-markers'},true);
  await call('plugin_enable',{pluginId:'example.clip-markers',enabled:true});
  const output=await call('plugin_run',{pluginId:'example.clip-markers',parameters:{prefix:'Check'}});
  assert.equal(output.commands.length,1);
  assert.ok(output.logs.some(log=>log.message.includes('1 video clips')));
  assert.deepEqual(await call('timeline_state'),initial,'Running a plugin should only propose edits');
  await call('proposal_apply',{proposalId:output.proposal.id});
  assert.equal((await call('timeline_state')).markers[0].name,'Check 1: fixture.mp4');
  await call('undo');
  assert.deepEqual(await call('timeline_state'),initial);
  const sandboxId='test.sandbox';
  await fixture(sandboxId,`export default async function(context) {let network='allowed'; try {await fetch('http://127.0.0.1:${server.address().port}/probe')} catch {network='blocked'}; return {summary:'Sandbox check',output:JSON.stringify({network,timeline:typeof context.timeline,media:typeof context.media,tauri:typeof self.__TAURI_INTERNALS__})};}`);
  const sandbox=JSON.parse((await call('plugin_run',{pluginId:sandboxId})).output);
  assert.deepEqual(sandbox,{network:'blocked',timeline:'undefined',media:'undefined',tauri:'undefined'});
  assert.equal(networkRequests,0);
  await fixture('test.permission',`export default () => ({summary:'Not permitted',commands:[{type:'add_marker',markerId:'forbidden',timeUs:0,name:'forbidden'}]})`);
  await call('plugin_run',{pluginId:'test.permission'},true);
  let installed=(await call('plugins_list')).plugins;
  assert.equal(installed.find(plugin=>plugin.manifest.id==='test.permission').enabled,false);
  assert.deepEqual(await call('timeline_state'),initial);
  await fixture('test.timeout','export default function(){while(true){}}');
  const started=Date.now();
  await call('plugin_run',{pluginId:'test.timeout'},true);
  assert.ok(Date.now()-started<12_000,'A plugin hang must be terminated promptly');
  await call('editor_state');
  await call('plugin_run',{pluginId:'example.clip-markers'});
  installed=(await call('plugins_list')).plugins;
  const installedPackage=installed.find(plugin=>plugin.manifest.id==='example.clip-markers');
  await writeFile(join(installedPackage.path,'main.js'),'export default () => ({summary:"Changed code"})');
  assert.equal((await call('plugins_list')).plugins.find(plugin=>plugin.manifest.id==='example.clip-markers').enabled,false);
  await call('plugin_run',{pluginId:'example.clip-markers'},true);
  await call('plugin_install',{folder:packageFolder,replace:true});
  assert.equal((await call('plugins_list')).plugins.find(plugin=>plugin.manifest.id==='example.clip-markers').enabled,false);
  const nativePackage=join(root,'engine/build/plugins/native-title');
  await call('plugin_install',{folder:nativePackage});
  await call('plugin_enable',{pluginId:'example.native-title',enabled:true},true);
  await call('plugin_developer_mode',{enabled:true});
  await call('plugin_enable',{pluginId:'example.native-title',enabled:true});
  const native=await call('plugin_run',{pluginId:'example.native-title',parameters:{text:'Native café title'}});
  assert.equal(native.commands[0].text,'Native café title');
  await call('proposal_apply',{proposalId:native.proposal.id});
  assert.equal((await call('timeline_state')).titles[0].text,'Native café title');
  await call('undo');
  assert.deepEqual(await call('timeline_state'),initial);
  const faultFolder = join(directory,'native-fault');
  await mkdir(faultFolder);
  await writeFile(join(faultFolder,'plugin.json'),JSON.stringify({id:'test.native-fault',name:'Native failure fixture',version:'1',type:'cpp',entry:'fault.dll',permissions:[],parameters:[{id:'mode',label:'Mode',type:'string',default:'exit',options:['exit','timeout']}]}));
  await copyFile(join(root,'engine/build/Debug/native-plugin-fault.dll'),join(faultFolder,'fault.dll'));
  await call('plugin_install',{folder:faultFolder});
  for (const mode of ['exit','timeout']) {
    await call('plugin_enable',{pluginId:'test.native-fault',enabled:true});
    const started=Date.now();
    const failed=await call('plugin_run',{pluginId:'test.native-fault',parameters:{mode}},true);
    assert.match(failed.content[0].text,mode==='exit'?/exited with/:/time limit/);
    assert.ok(Date.now()-started<12_000);
    assert.deepEqual(await call('timeline_state'),initial,'Native process failure must preserve the editor session');
    assert.equal((await call('plugins_list')).plugins.find(plugin=>plugin.manifest.id==='test.native-fault').enabled,false);
  }
  await call('plugin_developer_mode',{enabled:false});
  await call('plugin_run',{pluginId:'example.native-title'},true);
  await call('plugin_remove',{pluginId:'test.timeout'});
  assert.ok(!(await call('plugins_list')).plugins.some(plugin=>plugin.manifest.id==='test.timeout'));
  await writeFile(join(directory,'report.json'),JSON.stringify({checks,sandbox,networkRequests},null,2));
  console.log(`Live plugin integration passed: ${checks.length} calls; sandbox, permissions, timeout, tampering, proposals/undo, and native DLL. Artifacts: ${directory}`);
} finally { server.close(); await client.close(); }
