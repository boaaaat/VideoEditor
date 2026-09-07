// Opt-in native regression using only its own generated media and project folders.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,utimes} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=resolve(root,'engine/build',`mcp-playback-render-${Date.now()}`);
await mkdir(directory,{recursive:true});
const client=new Client({name:'live-playback-render',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'packages/mcp/src/index.mjs')],env:process.env,stderr:'pipe'}));
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
  return result.structuredContent??JSON.parse(result.content.find(item=>item.type==='text').text);
}
function ffmpeg(args) {
  const result=spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error',...args],{windowsHide:true,maxBuffer:50*1024*1024});
  assert.equal(result.status,0,String(result.stderr));return result.stdout;
}
async function completed(job) {
  for(let i=0;i<600;i++) {
    const status=await call('playback_render_status',{jobId:job.jobId});
    if(status.state==='completed') return status;
    assert.ok(!['failed','cancelled'].includes(status.state),JSON.stringify(status));
    await delay(150);
  }
  throw new Error('Playback render timeout');
}
async function preview(maxWidth=320) {return completed(await call('playback_render',{maxWidth}));}
async function exportMovie(path) {
  await call('export_start',{outputPath:path,quality:'pro_max'});
  for(let i=0;i<300;i++) { const status=await call('export_status'); if(status.state==='completed')return status; assert.notEqual(status.state,'failed',JSON.stringify(status)); await delay(200); }
  throw new Error('Export timeout');
}
function probe(path) {
  const result=spawnSync(join(root,'tools/ffmpeg/bin/ffprobe.exe'),['-v','error','-show_streams','-show_format','-of','json',path],{windowsHide:true});
  assert.equal(result.status,0,String(result.stderr));return JSON.parse(result.stdout);
}
try {
  const current=await call('editor_state');
  assert.ok(!current.project.path || resolve(current.project.path).startsWith(resolve(root,'engine/build','mcp-playback-render-')),'Use a fresh editor or a previous playback-render fixture');
  assert.equal(current.playing,false);
  assert.notEqual((await call('export_status')).state,'running');
  const source=join(directory,'motion café 日本.mp4'),tone=join(directory,'background.wav');
  ffmpeg(['-f','lavfi','-i','testsrc2=s=640x360:r=30','-f','lavfi','-i','sine=f=440:r=48000','-t','8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',source]);
  ffmpeg(['-f','lavfi','-i','sine=f=880:r=48000','-t','8','-c:a','pcm_s16le',tone]);
  await call('project_create',{path:join(directory,'project'),name:'Rendered playback review'});
  await call('project_settings',{width:640,height:360,fps:30,audioEnabled:true,masterGainDb:-3,normalizeAudio:true,cleanupAudio:true});
  await call('media_import',{paths:[source,tone]});
  const media=(await call('media_list')).media;
  const video=media.find(asset=>asset.kind==='video'),audio=media.find(asset=>asset.kind==='audio');
  await call('add_clip',{clipId:'motion',mediaId:video.id,trackId:'v1',startUs:500000,inUs:1000000,outUs:8000000,speedPercent:200,
    audio:{gainDb:-9,fadeInUs:1500000,fadeOutUs:1000000,normalize:true,cleanup:true},transform:{scale:.8,rotation:5,opacity:.9,fadeInUs:1500000,fadeOutUs:1000000},color:{temperature:25,tint:-10,brightness:5}});
  await call('add_clip',{clipId:'music',mediaId:audio.id,trackId:'a1',startUs:0,outUs:5000000,audio:{gainDb:-18,fadeOutUs:2000000,normalize:true}});
  await call('add_title',{titleId:'ending',text:'Playback + audio',startUs:1000000,durationUs:5000000,fontSize:30});
  await call('split_clip',{clipId:'motion',playheadUs:1200000});
  const history=await call('history');
  const movie=await preview();
  assert.equal(movie.cached,false);assert.equal(movie.durationUs,6000000);assert.equal(movie.width,320);assert.equal(movie.height,180);
  const metadata=probe(movie.path);assert.equal(metadata.streams.find(stream=>stream.codec_type==='video').codec_name,'h264');assert.equal(metadata.streams.find(stream=>stream.codec_type==='audio').codec_name,'aac');
  assert.ok(Math.abs(Number(metadata.format.duration)-6)<.05);
  const reference=join(directory,'export.mp4');await exportMovie(reference);
  const samples=[.2,.8,1.3,2,3.5,4.5,5.5];
  for(const time of samples) {
    const tail=['-frames:v','1','-vf','scale=160:90','-pix_fmt','rgb24','-f','rawvideo','pipe:1'];
    const a=ffmpeg(['-ss',String(time),'-i',movie.path,...tail]),b=ffmpeg(['-ss',String(time),'-i',reference,...tail]);
    assert.equal(a.length,b.length);let difference=0;for(let i=0;i<a.length;i++) difference+=Math.abs(a[i]-b[i]);
    const mae=difference/a.length;comparisons.push({time,mae});assert.ok(mae<5,`Playback pixels differ at ${time}: ${mae}`);
  }
  const audioArgs=['-vn','-ar','48000','-ac','2','-f','s16le','pipe:1'];
  const actual=ffmpeg(['-i',movie.path,...audioArgs]),expected=ffmpeg(['-i',reference,...audioArgs]);
  assert.ok(actual.equals(expected),'The complete normalized/cleaned mix should decode identically');
  assert.deepEqual(await call('history'),history,'Rendering must not add undo entries');
  const cached=await preview();assert.equal(cached.cached,true);assert.equal(cached.path,movie.path);
  // Detect a file that retained its MP4 header but lost its movie data.
  const original=await readFile(movie.path);await writeFile(movie.path,original.subarray(0,32));
  const repaired=await preview();assert.equal(repaired.cached,false);assert.ok((await readFile(repaired.path)).length>32);
  await call('apply_audio_adjustment',{clipId:'music',adjustment:{gainDb:-12}});
  const edited=await preview();assert.notEqual(edited.path,movie.path);
  await call('undo');assert.equal((await preview()).path,movie.path);
  const now=new Date();await utimes(source,now,now);
  const changed=await preview();assert.notEqual(changed.path,movie.path);assert.equal(changed.cached,false);
  const cancelled=await call('playback_render',{maxWidth:640});
  assert.equal((await call('playback_render_cancel',{jobId:cancelled.jobId})).state,'cancelled');
  await delay(500);assert.equal((await call('playback_render_status',{jobId:cancelled.jobId})).state,'cancelled');
  await call('project_settings',{audioEnabled:false});
  const silent=await preview();assert.ok(!probe(silent.path).streams.some(stream=>stream.codec_type==='audio'));
  await call('undo');await call('project_save');
  await call('set_clip_source_range',{clipId:'music',inUs:0,outUs:8000000});
  const extended=await preview();assert.equal(extended.durationUs,8000000,'Audio after the last picture must be retained');
  const extendedExport=join(directory,'audio-tail.mp4');assert.equal((await exportMovie(extendedExport)).durationUs,8000000);
  const tail=ffmpeg(['-ss','7','-i',extended.path,'-t','0.2',...audioArgs]);
  let sum=0;for(let i=0;i<tail.length;i+=2) sum+=tail.readInt16LE(i)**2;
  assert.ok(sum>100000,'The audio tail should be audible');
  await call('undo');await call('project_save');
  console.log(`Playback render integration passed: ${checks.length} calls, ${comparisons.length} video comparisons, byte-identical decoded mixed audio. Artifacts: ${directory}`);
} finally {await writeFile(join(directory,'report.json'),JSON.stringify({checks,comparisons},null,2));await client.close();}
