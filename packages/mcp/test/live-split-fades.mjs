// Compare real rendered pixels and audio before/after repeated splits inside fades.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=resolve(root,'engine/build',`mcp-split-fades-${Date.now()}`);
await mkdir(directory,{recursive:true});
const client=new Client({name:'live-split-fades',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'packages/mcp/src/index.mjs')],stderr:'pipe'}));
const checks=[],comparisons=[];
async function call(name,args={}) {
  if(name==='project_create'||name==='project_open') args={...args,remember:false};
  let result;
  for(let attempt=0;attempt<40;attempt++) {
    result=await client.callTool({name,arguments:args},undefined,{timeout:130000});
    if(!result.isError||!result.content?.some(item=>item.type==='text'&&/Editor is busy\. No action was taken|still starting/.test(item.text))) break;
    await delay(250);
  }
  checks.push(name);assert.ok(!result.isError,JSON.stringify(result));
  if(name==='timeline_frame') return Buffer.from(result.content.find(item=>item.type==='image').data,'base64');
  return result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
}
function ffmpeg(args) {
  const result=spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error',...args],{windowsHide:true,maxBuffer:30*1024*1024});
  assert.equal(result.status,0,String(result.stderr));return result.stdout;
}
async function render(path) {
  await call('export_start',{outputPath:path,quality:'pro_max'});
  for(let i=0;i<100;i++) {
    const status=await call('export_status');
    if(status.state==='completed')return;
    assert.notEqual(status.state,'failed',JSON.stringify(status));await delay(200);
  }
  throw new Error('Export did not finish');
}
function rms(pcm,start,duration=.1) {
  const first=Math.round(start*48000),last=Math.min(pcm.length/2,Math.round((start+duration)*48000));
  let squared=0;for(let i=first;i<last;i++) squared+=pcm.readInt16LE(i*2)**2;
  return Math.sqrt(squared/(last-first));
}
try {
  const current=await call('editor_state');
  assert.ok(!current.project.path || resolve(current.project.path).startsWith(resolve(root,'engine/build','mcp-split-fades-')),'Use a fresh editor or a previous split-fade fixture');
  assert.equal(current.playing,false);
  assert.ok(!['running','queued','cancelling'].includes((await call('export_status')).state),'Wait for the current export');
  const source=join(directory,'red-tone.mp4');
  ffmpeg(['-f','lavfi','-i','color=c=red:s=320x180:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',source]);
  const stereoSource=join(directory,'stereo-tone.mp4');
  ffmpeg(['-f','lavfi','-i','color=c=red:s=320x180:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-filter_complex','[1:a][2:a]amerge=inputs=2[a]','-map','0:v','-map','[a]','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',stereoSource]);
  for(const channels of [1,2]) for(const speed of [100,200]) {
    const project=join(directory,`project-${speed}-${channels}`);
    await call('project_create',{path:project,name:`Split fades ${speed}%, ${channels} channels`});
    await call('project_settings',{width:320,height:180,fps:30,audioEnabled:true});
    await call('media_import',{paths:[channels===1?source:stereoSource]});
    const media=(await call('media_list')).media[0];
    const fades={fadeInUs:2000000,fadeOutUs:2000000};
    await call('add_clip',{clipId:'original',mediaId:media.id,trackId:'v1',startUs:0,outUs:4000000*speed/100,speedPercent:speed,audio:fades,transform:fades});
    const beforeState=(await call('editor_state')).timeline;
    const before=join(directory,`before-${speed}-${channels}.mp4`),after=join(directory,`after-${speed}-${channels}.mp4`);
    const sampleTimes=[.4,.8,.833333,1.2,2,3.2,3.6];
    const frames=[];for(const time of sampleTimes) frames.push(await call('timeline_frame',{timeUs:Math.round(time*1000000),maxWidth:320}));
    await render(before);
    await call('split_clip',{clipId:'original',playheadUs:800000});
    const right=(await call('editor_state')).timeline.tracks.find(track=>track.id==='v1').clips[1];
    await call('split_clip',{clipId:right.id,playheadUs:3200000});
    const splitState=(await call('editor_state')).timeline;
    assert.equal(splitState.tracks.find(track=>track.id==='v1').clips[2].audio.fadeOffsetUs,3200000);
    await call('undo');await call('undo');
    assert.deepEqual((await call('editor_state')).timeline,beforeState);
    await call('redo');await call('redo');
    await call('project_save');await call('project_open',{path:project});
    assert.deepEqual((await call('editor_state')).timeline,splitState);
    for(let i=0;i<sampleTimes.length;i++) assert.deepEqual(await call('timeline_frame',{timeUs:Math.round(sampleTimes[i]*1000000),maxWidth:320}),frames[i],`Paused frame changed after split at ${sampleTimes[i]}s (${speed}%)`);
    await render(after);
    const pcmBefore=ffmpeg(['-i',before,'-vn','-ac','1','-ar','48000','-f','s16le','pipe:1']);
    const pcmAfter=ffmpeg(['-i',after,'-vn','-ac','1','-ar','48000','-f','s16le','pipe:1']);
    for(const time of sampleTimes) {
      const args=['-frames:v','1','-vf','scale=32:18','-pix_fmt','rgb24','-f','rawvideo','pipe:1'];
      const a=ffmpeg(['-ss',String(time),'-i',before,...args]),b=ffmpeg(['-ss',String(time),'-i',after,...args]);
      assert.equal(a.length,b.length);let difference=0;for(let i=0;i<a.length;i++)difference+=Math.abs(a[i]-b[i]);
      const mae=difference/a.length;
      const levelBefore=rms(pcmBefore,time),levelAfter=rms(pcmAfter,time),rmsRatio=levelAfter/levelBefore;
      comparisons.push({speed,channels,time,mae,rmsRatio});
      assert.ok(mae<2,`Split changed video at ${time}s (${speed}%): MAE ${mae}`);
      assert.ok(Math.abs(rmsRatio-1)<.06,`Split changed audio at ${time}s (${speed}%): RMS ratio ${rmsRatio}`);
    }
  }
  console.log(`Split fade integration passed: ${checks.length} calls, ${comparisons.length} pixel/audio comparisons. Artifacts: ${directory}`);
} finally {await writeFile(join(directory,'report.json'),JSON.stringify({checks,comparisons},null,2));await client.close();}
