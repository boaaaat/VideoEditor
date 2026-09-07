// Explicit integration scenario against a fresh desktop window with agent access.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../',import.meta.url));
const directory = resolve(root,'engine/build',`mcp-subtitles-${Date.now()}`);
await mkdir(directory,{recursive:true});
const client = new Client({name:'live-subtitle-check',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'packages/mcp/src/index.mjs')],stderr:'pipe'}));
const checks=[];
async function call(name,args={},expectError=false) {
  if (name === 'project_create' || name === 'project_open') args = {...args,remember:false};
  let result;
  for(let attempt=0;attempt<40;attempt++) {
    result=await client.callTool({name,arguments:args},undefined,{timeout:130000});
    if(!result.isError || !result.content?.some(item=>item.type==='text'&&item.text.includes('Editor is busy. No action was taken'))) break;
    await delay(250);
  }
  if(expectError) {assert.equal(result.isError,true,JSON.stringify(result));checks.push(`${name}: rejected`);return result;}
  assert.ok(!result.isError,JSON.stringify(result));checks.push(name);
  return result.structuredContent??JSON.parse(result.content[0].text);
}
async function exportVideo(path,rangeStartUs,rangeEndUs) {
  await call('export_start',{outputPath:path,rangeStartUs,rangeEndUs});
  for(let attempt=0;attempt<120;attempt++) {
    const result=await call('export_status');
    if(result.state==='completed') return result;
    assert.notEqual(result.state,'cancelled');
    await delay(500);
  }
  throw new Error('Subtitle export did not complete in time');
}
function whitePixels(path,time) {
  const decoded=spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error','-ss',String(time),'-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:4*1024*1024});
  assert.equal(decoded.status,0,String(decoded.stderr));
  let count=0;
  for(let i=0;i<decoded.stdout.length;i+=3) if(decoded.stdout[i]>180&&decoded.stdout[i+1]>180&&decoded.stdout[i+2]>180) count++;
  return count;
}
try {
  for(let attempt=0;attempt<40;attempt++) {const result=await client.callTool({name:'editor_state',arguments:{}});if(!result.isError) break;await delay(200);}
  assert.ok(!(await call('editor_state')).project.path,'Use a fresh editor for this test.');
  const project=join(directory,'project');
  await call('project_create',{path:project,name:'Caption integration check'});
  await call('project_settings',{width:640,height:360,fps:30});
  await call('add_title',{titleId:'keep',text:'Ordinary title',startUs:0,durationUs:200000});
  const before=await call('timeline_state');
  const initialHistory=await call('history');
  const srt='\uFEFF1\r\n00:00:00,500 --> 00:00:01,500\r\nHello café &amp; 你好\r\nSecond line\r\n\r\n2\r\n00:00:01,250 --> 00:00:02,000\r\nOverlap 👋\r\n';
  assert.equal((await call('subtitles_import',{content:srt,format:'srt',offsetUs:250000})).count,2);
  const imported=await call('timeline_state');
  assert.equal(imported.titles.length,3);
  assert.equal(imported.titles[1].kind,'caption');
  assert.equal(imported.titles[1].startUs,750000);
  assert.equal(imported.titles[1].text,'Hello café & 你好\nSecond line');
  assert.equal((await call('history')).undoCount,initialHistory.undoCount+1);
  await call('undo');assert.deepEqual(await call('timeline_state'),before);
  await call('redo');assert.deepEqual(await call('timeline_state'),imported);
  const vtt=await call('subtitles_export',{format:'vtt',path:join(directory,'captions.vtt')});
  assert.equal(vtt.count,2);assert.ok(vtt.content.startsWith('WEBVTT\n\n'));assert.ok(!vtt.content.includes('Ordinary title'));
  assert.equal(await readFile(join(directory,'captions.vtt'),'utf8'),vtt.content);
  await call('subtitles_export',{format:'srt',path:join(directory,'captions.vtt')},true);
  assert.equal(await readFile(join(directory,'captions.vtt'),'utf8'),vtt.content,'Rejected overwrite must preserve file');
  await call('subtitles_export',{format:'vtt',path:join(directory,'captions.exe')},true);
  const savedHistory=await call('history');
  await call('subtitles_import',{content:srt+'\n3\nmalformed\nBad',format:'srt',mode:'replace'},true);
  assert.deepEqual(await call('timeline_state'),imported);assert.deepEqual(await call('history'),savedHistory);
  await call('subtitles_import',{content:vtt.content,format:'vtt',mode:'replace'});
  let current=await call('timeline_state');
  assert.equal(current.titles[0].id,'keep');
  const data=(titles)=>titles.filter(title=>title.kind==='caption').map(({text,startUs,durationUs})=>({text,startUs,durationUs}));
  assert.deepEqual(data(current.titles),data(imported.titles));
  await call('project_save');await call('project_open',{path:project});
  assert.deepEqual(data((await call('timeline_state')).titles),data(imported.titles));
  const rendered=join(directory,'captions.mp4');
  await exportVideo(rendered,500000,2250000);
  const beforeCue=whitePixels(rendered,0.1);
  const insideCue=whitePixels(rendered,0.5);
  assert.ok(insideCue>beforeCue+150,'Caption text should appear only during its timeline interval');
  const cues=Array.from({length:501},(_,index)=>({text:`Cue ${index+1}`,startUs:index*2000,durationUs:2000}));
  await call('import_captions',{captions:cues,mode:'replace'});
  assert.equal((await call('subtitles_export',{format:'srt'})).count,501);
  const dense=await exportVideo(join(directory,'many-captions.mp4'),0,1002000);
  assert.ok(dense.logs.some(log=>log.includes('-filter_complex_script')),'Large caption graphs should avoid Windows command-line limits');
  const report={checks,beforeCue,insideCue,denseCaptions:501};
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));
  console.log(`Live subtitle integration passed: ${checks.length} calls; round-trip, undo, persistence, overwrite protection, caption pixels, and 501-cue export. Artifacts: ${directory}`);
} finally {await client.close();}
