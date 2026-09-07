// Explicit integration check: run with the desktop app open and agent access enabled.
// Creates its own project and synthetic media under engine/build; never edits an existing project.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = resolve(root, 'engine/build', `mcp-live-${Date.now()}`);
await mkdir(directory, { recursive: true });
const source = join(directory, 'source 10% & check.mp4');
const ffmpeg = resolve(root, 'tools/ffmpeg/bin/ffmpeg.exe');
const ffprobe = resolve(root, 'tools/ffmpeg/bin/ffprobe.exe');
const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
const client = new Client({ name: 'live-editor-check', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], stderr: 'pipe' });
await client.connect(transport);
const report = [];
async function call(name, args = {}, expectError = false) {
  if (name === 'project_create' || name === 'project_open') args = {...args,remember:false};
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 130_000 });
  if (expectError) { assert.equal(result.isError, true, JSON.stringify(result)); return result; }
  assert.ok(!result.isError, JSON.stringify(result));
  report.push(name);
  return result.structuredContent ?? (result.content[0]?.type === 'text' ? JSON.parse(result.content[0].text) : result);
}
try {
  // Only read-only startup discovery is retried; mutation outcomes are never guessed.
  for (let attempt = 0; attempt < 30; attempt++) {
    const ready = await client.callTool({ name: 'editor_state', arguments: {} });
    if (!ready.isError) break;
    await delay(200);
  }
  const initial = await call('editor_state');
  assert.ok(!initial.project?.path, 'Run this check in a fresh editor with no project open.');
  await call('project_create', { path: join(directory, 'project'), name: 'MCP integration check' });
  await call('media_import', { paths: [source] });
  const media = (await call('media_list')).media[0];
  assert.ok(media.metadata.width > 0);
  await call('edit_batch', { commands: [
    { type: 'add_clip', clipId: 'mcp_clip', mediaId: media.id, trackId: 'v1', startUs: 0, inUs: 0, outUs: 4_000_000, speedPercent: 200 },
    { type: 'apply_color_adjustment', clipId: 'mcp_clip', adjustment: { brightness: 10 } },
    { type: 'apply_audio_adjustment', clipId: 'mcp_clip', adjustment: { gainDb: -6, fadeInUs: 200_000 } }
  ] });
  const before = await call('timeline_state');
  const beforeHistory = await call('history');
  const brokenProject = join(directory, 'broken-project');
  await mkdir(brokenProject);
  await writeFile(join(brokenProject, 'project.aivproj'), JSON.stringify({ version: 1, name: 'Broken project', database: 'project.db' }));
  await writeFile(join(brokenProject, 'project.db'), 'Invalid SQLite contents');
  await call('project_open', { path: brokenProject }, true);
  assert.deepEqual(await call('timeline_state'), before);
  assert.deepEqual(await call('history'), beforeHistory);
  assert.equal((await call('editor_state')).project.path, join(directory, 'project'));
  await call('edit_batch', { commands: [
    { type: 'move_clip', clipId: 'mcp_clip', trackId: 'v1', startUs: 500_000 },
    { type: 'move_clip', clipId: 'missing', trackId: 'v1', startUs: 0 }
  ] }, true);
  assert.deepEqual(await call('timeline_state'), before);
  assert.deepEqual(await call('history'), beforeHistory);
  await call('undo');
  assert.equal((await call('timeline_state')).tracks.flatMap((track) => track.clips).length, 0);
  await call('redo');
  assert.deepEqual(await call('timeline_state'), before);
  const frame = await call('media_frame', { mediaId: media.id, timeUs: 1_000_000 });
  assert.equal(frame.content[0].type, 'image');
  const proposal = await call('propose_edits', { goal: 'Shorten the test clip', explanation: 'Trim the source out to two seconds.', commands: [{ type: 'trim_clip', clipId: 'mcp_clip', edge: 'end', timeUs: 2_000_000 }] });
  assert.deepEqual(await call('timeline_state'), before);
  await call('proposal_apply', { proposalId: proposal.id });
  await call('undo');
  assert.deepEqual(await call('timeline_state'), before);
  assert.equal((await call('proposals_list')).proposals.find((item) => item.id === proposal.id).status, 'pending');
  await call('project_settings', { width: 640, height: 360, fps: 30 });
  await call('project_settings', { fps: 24, masterGainDb: -8 });
  assert.equal((await call('editor_state')).projectSettings.fps, 24);
  await call('undo');
  assert.equal((await call('editor_state')).projectSettings.fps, 30);
  await call('redo');
  assert.equal((await call('editor_state')).projectSettings.masterGainDb, -8);
  await call('undo');
  const output = join(directory, 'output.mp4');
  await call('export_start', { outputPath: output });
  let status;
  const deadline = Date.now() + 90_000;
  do { await delay(500); status = await call('export_status'); } while (status.state === 'running' && Date.now() < deadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8', windowsHide: true });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.streams.find((stream) => stream.codec_type === 'video').width, 640);
  assert.ok(metadata.streams.some((stream) => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.15);
  await call('project_save');
  await call('add_marker', { markerId: 'review', timeUs: 750_000, name: 'Review beat', color: '#ffcc66' });
  await call('update_marker', { markerId: 'review', name: 'Opening beat' });
  await call('project_save');
  await call('project_open', { path: join(directory, 'project') });
  assert.equal((await call('timeline_state')).markers[0].name, 'Opening beat');
  await call('delete_marker', { markerId: 'review' });
  await call('undo');
  assert.equal((await call('timeline_state')).markers[0].id, 'review');
  const solids = [];
  for (const color of ['blue', 'red']) {
    const path = join(directory, `${color}.mp4`);
    const generated = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=30:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path], { encoding: 'utf8', windowsHide: true });
    assert.equal(generated.status, 0, generated.stderr);
    solids.push(path);
  }
  await call('media_import', { paths: solids });
  const allMedia = (await call('media_list')).media;
  await call('edit_batch', { commands: [
    { type: 'delete_clip', clipId: 'mcp_clip' },
    { type: 'add_clip', clipId: 'background', mediaId: allMedia.find((item) => item.path === solids[0]).id, trackId: 'v1', startUs: 0, outUs: 2_000_000 },
    { type: 'add_clip', clipId: 'overlay', mediaId: allMedia.find((item) => item.path === solids[1]).id, trackId: 'v2', startUs: 500_000, outUs: 1_000_000, transform: { scale: 0.5, opacity: 0.5, fadeInUs: 250_000, fadeOutUs: 250_000 } }
  ] });
  const layeredOutput = join(directory, 'layers.mp4');
  await call('export_start', { outputPath: layeredOutput });
  const layersDeadline = Date.now() + 90_000;
  do { await delay(300); status = await call('export_status'); } while (status.state === 'running' && Date.now() < layersDeadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  function pixel(seconds, x, y, file = layeredOutput) {
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', file, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.equal(decoded.stdout.length, 3);
    return [...decoded.stdout];
  }
  const beforeOverlay = pixel(0.2, 320, 180);
  const blendedCenter = pixel(1, 320, 180);
  const outsideOverlay = pixel(1, 40, 40);
  const fadeStart = pixel(0.533, 320, 180);
  const afterOverlay = pixel(1.7, 320, 180);
  assert.ok(beforeOverlay[2] > 180 && beforeOverlay[0] < 30, String(beforeOverlay));
  assert.ok(blendedCenter[0] > 80 && blendedCenter[2] > 80, String(blendedCenter));
  assert.ok(outsideOverlay[2] > 180 && outsideOverlay[0] < 30, String(outsideOverlay));
  assert.ok(fadeStart[0] < blendedCenter[0] / 2, String(fadeStart));
  assert.ok(afterOverlay[2] > 180 && afterOverlay[0] < 30, String(afterOverlay));
  const titleText = "Agent's 100%: [café]\nSecond line";
  await call('add_title', { titleId: 'caption', text: titleText, startUs: 500_000, durationUs: 1_000_000, fontSize: 24, positionY: 80 });
  await call('project_save');
  await call('project_open', { path: join(directory, 'project') });
  assert.equal((await call('timeline_state')).titles[0].text, titleText);
  const titledOutput = join(directory, 'titles.mp4');
  await call('export_start', { outputPath: titledOutput });
  const titleDeadline = Date.now() + 90_000;
  do { await delay(300); status = await call('export_status'); } while (status.state === 'running' && Date.now() < titleDeadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  function whitePixels(seconds, file = titledOutput) {
    const decoded = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    let white = 0;
    for (let offset = 0; offset < decoded.stdout.length; offset += 3) if (decoded.stdout[offset] > 200 && decoded.stdout[offset + 1] > 200 && decoded.stdout[offset + 2] > 200) white++;
    return white;
  }
  assert.equal(whitePixels(0.2), 0);
  assert.ok(whitePixels(1) > 150, 'Expected visible white title glyphs inside its timing interval');
  assert.equal(whitePixels(1.8), 0);
  const rangeOutput = join(directory, 'title-range.mp4');
  await call('export_start', { outputPath: rangeOutput, rangeStartUs: 750_000, rangeEndUs: 1_750_000 });
  const rangeDeadline = Date.now() + 90_000;
  do { await delay(300); status = await call('export_status'); } while (status.state === 'running' && Date.now() < rangeDeadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  assert.equal(status.rangeStartUs, 750_000);
  assert.equal(status.durationUs, 1_000_000);
  const rangeProbe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', rangeOutput], { encoding: 'utf8', windowsHide: true });
  const rangeMetadata = JSON.parse(rangeProbe.stdout);
  assert.ok(Math.abs(Number(rangeMetadata.format.duration) - 1) < 0.1);
  assert.ok(rangeMetadata.streams.some((stream) => stream.codec_type === 'audio'));
  assert.ok(whitePixels(0.2, rangeOutput) > 150);
  assert.equal(whitePixels(0.9, rangeOutput), 0);
  await call('export_start', { outputPath: join(directory, 'invalid-range.mp4'), rangeStartUs: 2_000_000, rangeEndUs: 1_000_000 }, true);
  await call('set_clip_source_range', { clipId: 'background', inUs: 500_000, outUs: 1_500_000 });
  const trimmed = (await call('timeline_state')).tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'background');
  assert.equal(trimmed.startUs, 0);
  assert.equal(trimmed.inUs, 500_000);
  await call('undo');
  await call('edit_batch', { commands: [
    { type: 'delete_title', titleId: 'caption' },
    { type: 'delete_clip', clipId: 'overlay' },
    { type: 'add_clip', clipId: 'successor', mediaId: allMedia.find((item) => item.path === solids[1]).id, trackId: 'v1', startUs: 2_000_000, outUs: 2_000_000 }
  ] });
  const beforeCrossfade = await call('timeline_state');
  await call('crossfade_clips', { firstClipId: 'background', secondClipId: 'successor', durationUs: 500_000 });
  const crossfaded = await call('timeline_state');
  assert.equal(crossfaded.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'successor').startUs, 1_500_000);
  await call('undo');
  assert.deepEqual(await call('timeline_state'), beforeCrossfade);
  await call('redo');
  assert.deepEqual(await call('timeline_state'), crossfaded);
  const stillPath = join(directory, 'green.png');
  const image = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=640x360', '-frames:v', '1', stillPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(image.status, 0, image.stderr);
  await call('media_import', { paths: [stillPath] });
  const still = (await call('media_list')).media.find((item) => item.path === stillPath);
  assert.equal(still.metadata.isStillImage, true);
  await call('add_clip', { clipId: 'still', mediaId: still.id, trackId: 'v2', startUs: 4_000_000, outUs: 8_000_000 });
  await call('playback', { timeUs: 4_000_000, playing: true });
  await delay(1200);
  const stillPlayback = await call('editor_state');
  assert.ok(stillPlayback.playheadUs > 4_500_000, `Still preview did not advance: ${stillPlayback.playheadUs}`);
  await call('playback', { playing: false });
  await call('playback', { timeUs: 11_800_000, playing: true });
  await delay(900);
  const endedPlayback = await call('editor_state');
  assert.equal(endedPlayback.playing, false);
  assert.equal(endedPlayback.playheadUs, 12_000_000);
  await call('playback', { timeUs: 3_600_000, playing: true });
  await delay(1200);
  assert.ok((await call('editor_state')).playheadUs > 4_300_000, 'Playback should cross an empty gap into the still');
  await call('playback', { playing: false, timeUs: 0 });
  const featuresOutput = join(directory, 'crossfade-and-still.mp4');
  await call('export_start', { outputPath: featuresOutput });
  const featuresDeadline = Date.now() + 90_000;
  do { await delay(300); status = await call('export_status'); } while (status.state === 'running' && Date.now() < featuresDeadline);
  assert.equal(status.state, 'completed', JSON.stringify(status));
  const crossfadePixel = pixel(1.75, 320, 180, featuresOutput);
  assert.ok(crossfadePixel[0] > 70 && crossfadePixel[2] > 70, String(crossfadePixel));
  const stillPixel = pixel(11, 320, 180, featuresOutput);
  assert.ok(stillPixel[1] > 90 && stillPixel[0] < 30 && stillPixel[2] < 30, String(stillPixel));
  await call('project_save');
  await writeFile(join(directory, 'report.json'), JSON.stringify({ checks: report, outputs: [output, layeredOutput, titledOutput, rangeOutput, featuresOutput], pixelChecks: { blendedCenter, outsideOverlay, fadeStart, crossfadePixel, stillPixel } }, null, 2));
  console.log(`Live MCP integration passed: ${report.length} calls; audio, markers, titles, source ranges, crossfade undo, and layered/still export pixels. Artifacts: ${directory}`);
} finally { await client.close(); }
