// Explicit desktop regression. All source files and projects belong to this isolated fixture.
import assert from 'node:assert/strict';
import {mkdir,writeFile,rename,readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=resolve(root,'engine/build',`mcp-media-recovery-${Date.now()}`);
await mkdir(directory,{recursive:true});
const client=new Client({name:'live-media-recovery',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'packages/mcp/src/index.mjs')],stderr:'pipe'}));
const checks=[];
async function call(name,args={},expectError=false) {
  if(name==='project_create'||name==='project_open') args={...args,remember:false};
  let result;
  for(let attempt=0;attempt<40;attempt++) {
    result=await client.callTool({name,arguments:args},undefined,{timeout:130000});
    if(!result.isError||!result.content?.some(item=>item.type==='text'&&/Editor is busy\. No action was taken|still starting/.test(item.text))) break;
    await delay(250);
  }
  checks.push(expectError?`${name}: rejected`:name);
  if(expectError) {assert.equal(result.isError,true,JSON.stringify(result));return result;}
  assert.ok(!result.isError,JSON.stringify(result));
  return result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
}
function ffmpeg(args) {
  const result=spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error',...args],{windowsHide:true,maxBuffer:5*1024*1024});
  assert.equal(result.status,0,String(result.stderr));
}
function video(name,color,duration,streams=2) {
  const path=join(directory,name);
  const inputs=['-f','lavfi','-i',`color=c=${color}:size=320x180:rate=30`];
  for(let index=0;index<streams;index++) inputs.push('-f','lavfi','-i',`sine=frequency=${440+index*440}:sample_rate=48000`);
  inputs.push('-map','0:v');
  for(let index=0;index<streams;index++) inputs.push('-map',`${index+1}:a`);
  ffmpeg([...inputs,'-t',String(duration),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',path]);
  return path;
}
async function unchangedFailure(name,args) {
  const before=await call('editor_state');
  await call(name,args,true);
  const after=await call('editor_state');
  assert.deepEqual(after.mediaAssets,before.mediaAssets);
  assert.deepEqual(after.timeline,before.timeline);
  assert.deepEqual(after.history,before.history);
}
try {
  assert.ok(!(await call('editor_state')).project.path,'Use a fresh editor with no open project');
  const source=video('Original café 日本 10% & source.mp4','red',4);
  const replacement=video('replacement.mp4','blue',4);
  const shorter=video('shorter.mp4','green',1);
  const oneStream=video('one-stream.mp4','yellow',4,1);
  const audio=join(directory,'audio.wav');
  ffmpeg(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','4',audio]);
  const corrupt=join(directory,'corrupt.mp4');await writeFile(corrupt,'not a video');
  const missing=join(directory,'missing.mp4');
  const project=join(directory,'project');
  await call('project_create',{path:project,name:'Media recovery check'});
  await call('project_settings',{width:320,height:180,fps:30});
  await call('media_import',{paths:[source]});
  const asset=(await call('media_list')).media[0];
  assert.equal(asset.name,basename(source));assert.equal(asset.metadata.audioStreamCount,2);
  await mkdir(join(directory,'child'));
  await call('media_import',{paths:[`${directory}/child/../${basename(source)}`]});
  assert.equal((await call('media_list')).media.length,1,'Path aliases must reuse an imported source');
  for(const path of [missing,corrupt,directory]) await unchangedFailure('media_import',{paths:[replacement,path]});
  await call('edit_batch',{commands:[
    {type:'add_clip',clipId:'video',mediaId:asset.id,trackId:'v1',startUs:0,inUs:250000,outUs:3750000,color:{brightness:5}},
    {type:'add_clip',clipId:'second-audio',mediaId:asset.id,trackId:'a1',startUs:0,outUs:3500000,audio:{streamIndex:1}}
  ]});
  for(const path of [missing,corrupt,shorter,audio,oneStream]) await unchangedFailure('media_relink',{mediaId:asset.id,path});
  await call('update_track',{trackId:'v1',locked:true});
  await unchangedFailure('media_relink',{mediaId:asset.id,path:replacement});
  await call('update_track',{trackId:'v1',locked:false});
  const before=await call('editor_state');
  assert.equal((await call('media_check')).missingCount,0);
  assert.equal(dirname(source),directory);
  await rename(source,join(directory,'original-moved.mp4'));
  const missingReport=await call('media_check');
  assert.equal(missingReport.missingCount,1);assert.equal(missingReport.media[0].id,asset.id);
  await call('media_relink',{mediaId:asset.id,path:replacement});
  const relinked=await call('editor_state');
  assert.deepEqual(relinked.timeline,before.timeline);
  assert.equal(relinked.mediaAssets[0].id,asset.id);assert.equal(relinked.mediaAssets[0].name,basename(source));
  assert.equal(relinked.mediaAssets[0].path,replacement);
  assert.equal(relinked.history.undoCount,before.history.undoCount+1);
  assert.equal((await call('media_check')).missingCount,0);
  await call('undo');assert.equal((await call('media_check')).missingCount,1);
  await call('redo');assert.equal((await call('media_check')).missingCount,0);
  const copied=await call('media_import',{paths:[oneStream],copyToProject:true});
  const copy=copied.data.media[0];
  assert.equal(dirname(copy.path),join(project,'media'));
  assert.equal(copy.name,basename(oneStream));
  assert.deepEqual(await readFile(copy.path),await readFile(oneStream));
  await rename(oneStream,join(directory,'one-stream-moved.mp4'));
  assert.equal((await call('media_check')).missingCount,0,'Copied media must survive moving the external source');
  const filesBefore=await readdir(join(project,'media'));
  await unchangedFailure('media_import',{paths:[replacement,corrupt],copyToProject:true});
  assert.deepEqual(await readdir(join(project,'media')),filesBefore,'Failed copy import must clean up only its new files');
  await call('project_save');await call('project_open',{path:project});
  assert.equal((await call('media_check')).missingCount,0);
  assert.equal((await call('media_list')).media[0].path,replacement);
  const exportPath=join(directory,'relinked-export.mp4');
  await call('export_start',{outputPath:exportPath});
  let exportStatus;
  for(let attempt=0;attempt<100;attempt++) {exportStatus=await call('export_status');if(exportStatus.state==='completed')break;await delay(200);}
  assert.equal(exportStatus.state,'completed',JSON.stringify(exportStatus));
  const probe=spawnSync(join(root,'tools/ffmpeg/bin/ffprobe.exe'),['-v','error','-show_streams','-of','json',exportPath],{encoding:'utf8',windowsHide:true});
  assert.equal(probe.status,0,probe.stderr);
  const streams=JSON.parse(probe.stdout).streams;
  assert.ok(streams.some(stream=>stream.codec_type==='video')&&streams.some(stream=>stream.codec_type==='audio'));
  await writeFile(join(directory,'report.json'),JSON.stringify({checks,exportPath,sourceName:basename(source)},null,2));
  console.log(`Media recovery integration passed: ${checks.length} calls. Artifacts: ${directory}`);
} finally {await client.close();}
