// Explicit desktop regression: compares composition images with actual export pixels.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const directory=resolve(root,'engine/build',`mcp-composition-${Date.now()}`);
await mkdir(directory,{recursive:true});
const client=new Client({name:'live-composition-check',version:'1.0'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'packages/mcp/src/index.mjs')],stderr:'pipe'}));
const checks=[];const comparisons=[];
async function call(name,args={},expectError=false) {
  if (name === 'project_create' || name === 'project_open') args = {...args,remember:false};
  let result;
  for(let attempt=0;attempt<40;attempt++) {
    result=await client.callTool({name,arguments:args},undefined,{timeout:130000});
    if(!result.isError || !result.content?.some(item=>item.type==='text'&&/Editor is busy\. No action was taken|still starting/.test(item.text))) break;
    await delay(250);
  }
  checks.push(expectError?`${name}: rejected`:name);
  if(expectError) {assert.equal(result.isError,true,JSON.stringify(result));return result;}
  assert.ok(!result.isError,JSON.stringify(result));
  if(name==='timeline_frame') return {image:Buffer.from(result.content.find(item=>item.type==='image').data,'base64'),...JSON.parse(result.content.find(item=>item.type==='text').text)};
  return result.structuredContent??JSON.parse(result.content[0].text);
}
function ffmpeg(args,raw=false) {
  const result=spawnSync(join(root,'tools/ffmpeg/bin/ffmpeg.exe'),['-v','error',...args],{windowsHide:true,maxBuffer:10*1024*1024});
  assert.equal(result.status,0,String(result.stderr));return raw?result.stdout:String(result.stdout);
}
async function render(path,start,end) {
  await call('export_start',{outputPath:path,rangeStartUs:start,rangeEndUs:end,quality:'pro_max'});
  for(let i=0;i<100;i++) {const status=await call('export_status');if(status.state==='completed')return status;await delay(200);}
  throw new Error('Composition export did not finish');
}
async function compare(label,timeUs,start=0,end=2000000) {
  const frame=await call('timeline_frame',{timeUs,maxWidth:640});
  assert.equal(frame.width,640);assert.equal(frame.height,360);
  const png=join(directory,`${label}.png`);const video=join(directory,`${label}.mp4`);
  await writeFile(png,frame.image);await render(video,start,end);
  const image=ffmpeg(['-i',png,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],true);
  const exported=ffmpeg(['-ss',String((frame.timeUs-start)/1000000),'-i',video,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],true);
  assert.equal(image.length,exported.length);
  let absolute=0;let squared=0;
  for(let i=0;i<image.length;i++){const difference=image[i]-exported[i];absolute+=Math.abs(difference);squared+=difference*difference;}
  const mae=absolute/image.length;const psnr=squared?10*Math.log10(255*255/(squared/image.length)):Infinity;
  comparisons.push({label,mae,psnr});
  console.log(`${label}: MAE ${mae.toFixed(3)}, PSNR ${psnr.toFixed(2)} dB`);
  await writeFile(join(directory,'report.json'),JSON.stringify({checks,comparisons},null,2));
  assert.ok(mae<3&&psnr>32,`Preview differs from export: ${label} MAE=${mae} PSNR=${psnr}`);
  return frame;
}
const neutral={brightness:0,contrast:0,saturation:1,temperature:0,tint:0};
try {
  assert.ok(!(await call('editor_state')).project.path,'Use a fresh editor with no open project.');
  await call('project_create',{path:join(directory,'project'),name:'Composition fidelity check'});
  await call('project_settings',{width:640,height:360,fps:30,audioEnabled:false});
  const pattern=join(directory,'pattern.png');
  ffmpeg(['-f','lavfi','-i','testsrc2=size=640x360:rate=30','-frames:v','1',pattern]);
  await call('media_import',{paths:[pattern]});
  const media=(await call('media_list')).media[0];
  await call('add_clip',{clipId:'base',mediaId:media.id,trackId:'v1',startUs:0,outUs:2000000});
  const history=await call('history');
  const neutralFrame=await compare('neutral',1000000);
  const cached=await call('timeline_frame',{timeUs:1000000,maxWidth:640});
  assert.equal(cached.cached,true);assert.deepEqual(cached.image,neutralFrame.image);
  assert.deepEqual(await call('history'),history,'Frame inspection must not create history entries');
  assert.equal((await call('timeline_frame',{timeUs:33333,maxWidth:640})).timeUs,33333);
  await call('apply_color_adjustment',{clipId:'base',adjustment:{brightness:12,contrast:15,saturation:1.3,temperature:50,tint:-25}});
  await compare('color',1000000);
  await call('apply_color_adjustment',{clipId:'base',adjustment:neutral});
  for(const type of ['blur','sharpen','vignette','grayscale']) {
    await call('apply_effect_stack',{clipId:'base',effects:[{id:type,type,label:type,enabled:true,amount:65}]});
    await compare(type,1000000);
  }
  await call('apply_effect_stack',{clipId:'base',effects:[]});
  for(const lutId of ['warm','cool','filmic','mono']) {
    let lowerStrength;
    for(const strength of [0.25,0.75]) {
      await call('apply_lut',{clipId:'base',lutId,strength});
      const frame = await compare(`${lutId}-${strength}`,1000000);
      if (lowerStrength) assert.notDeepEqual(frame.image,lowerStrength,`${lutId} must respond to strength`);
      lowerStrength = frame.image;
    }
  }
  await call('apply_lut',{clipId:'base',lutId:null,strength:0});
  const bottomIndex = Math.max(...(await call('timeline_state')).tracks.map(track=>track.index))+1;
  await call('add_track',{kind:'video',trackId:'lower',index:bottomIndex,name:'Lower layer'});
  await call('add_clip',{clipId:'lower',mediaId:media.id,trackId:'lower',startUs:0,outUs:2000000,color:{brightness:-30}});
  await call('apply_transform',{clipId:'base',transform:{scale:0.7,rotation:15,positionX:34,positionY:-20,opacity:0.8,fadeInUs:2000000}});
  await call('add_title',{text:'Rendered title',titleId:'title',startUs:500000,durationUs:1000000,fontSize:30});
  const layered = await compare('layers-transform-fade-title',1000000);
  await call('apply_transform',{clipId:'base',transform:{opacity:0}});
  const lowerOnly = await call('timeline_frame',{timeUs:1000000,maxWidth:640});
  assert.notDeepEqual(layered.image,lowerOnly.image,'The transformed upper layer must contribute visible pixels');
  await call('apply_transform',{clipId:'base',transform:{opacity:0.8}});
  const afterTitle=await call('timeline_frame',{timeUs:1750000,maxWidth:320});assert.equal(afterTitle.width,320);
  await call('timeline_frame',{timeUs:-1},true);
  const moving=join(directory,'motion.mp4');
  ffmpeg(['-f','lavfi','-i','testsrc2=size=640x360:rate=30','-t','4','-c:v','libx264','-pix_fmt','yuv420p',moving]);
  await call('media_import',{paths:[moving]});
  const motion=(await call('media_list')).media.find(asset=>asset.path===moving);
  await call('add_clip',{clipId:'motion',mediaId:motion.id,trackId:'v1',startUs:3100000,inUs:400000,outUs:4000000,speedPercent:200});
  await compare('motion-speed',4000000,3000000,4900000);
  const beforeReplacement = await call('timeline_frame',{timeUs:1000000,maxWidth:640});
  ffmpeg(['-y','-f','lavfi','-i','color=c=orange:size=640x360','-frames:v','1',pattern]);
  const afterReplacement = await call('timeline_frame',{timeUs:1000000,maxWidth:640});
  assert.equal(afterReplacement.cached,false,'Changed source metadata must invalidate the frame cache');
  assert.notDeepEqual(afterReplacement.image,beforeReplacement.image);
  await writeFile(join(directory,'report.json'),JSON.stringify({checks,comparisons},null,2));
  console.log(`Live composition integration passed: ${checks.length} calls, ${comparisons.length} export comparisons. Artifacts: ${directory}`);
} finally {await client.close();}
