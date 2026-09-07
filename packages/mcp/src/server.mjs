import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const id = z.string().min(1).max(512);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).describe('Microseconds; 1 second = 1,000,000 microseconds.');
const color = z.object({ brightness: z.number().min(-100).max(100).optional(), contrast: z.number().min(-100).max(100).optional(), saturation: z.number().min(0).max(3).optional(), temperature: z.number().min(-100).max(100).optional(), tint: z.number().min(-100).max(100).optional() }).strict();
const audio = z.object({ gainDb: z.number().min(-60).max(12).optional(), muted: z.boolean().optional(), fadeInUs: time.optional(), fadeOutUs: time.optional(), fadeOffsetUs: time.optional(), fadeDurationUs: time.optional(), normalize: z.boolean().optional(), cleanup: z.boolean().optional(), streamIndex: z.number().int().nonnegative().optional() }).strict();
const transform = z.object({ enabled: z.boolean().optional(), scale: z.number().min(0.1).max(4).optional(), positionX: z.number().min(-8192).max(8192).optional(), positionY: z.number().min(-8192).max(8192).optional(), rotation: z.number().min(-180).max(180).optional(), opacity: z.number().min(0).max(1).optional(), fadeInUs: time.optional(), fadeOutUs: time.optional(), fadeOffsetUs: time.optional(), fadeDurationUs: time.optional() }).strict();
const effects = z.array(z.object({ id, type: z.enum(['blur', 'sharpen', 'vignette', 'grayscale']), label: z.string().max(80), enabled: z.boolean(), amount: z.number().min(0).max(100) }).strict()).max(32);
const titleText = z.string().min(1).refine((value) => new TextEncoder().encode(value).length <= 4000 && !value.includes('\0'), 'Text must fit in 4,000 UTF-8 bytes and contain no null characters');
const captionStyle = z.object({fontSize:z.number().int().min(10).max(300).optional(),color:z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),positionX:z.number().min(0).max(100).optional(),positionY:z.number().min(0).max(100).optional(),background:z.boolean().optional()}).strict();

const commandShapes = {
  import_captions: {captions:z.array(z.object({text:titleText,startUs:time,durationUs:time.positive()}).strict()).min(1).max(5000),mode:z.enum(['append','replace']).optional(),style:captionStyle.optional()},
  add_title: { titleId: id.optional(), kind: z.enum(['title', 'caption']).optional(), text: titleText, startUs: time, durationUs: time.positive().optional(), fontSize: z.number().int().min(10).max(300).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), positionX: z.number().min(0).max(100).optional(), positionY: z.number().min(0).max(100).optional(), background: z.boolean().optional() },
  update_title: { titleId: id, kind: z.enum(['title', 'caption']).optional(), text: titleText.optional(), startUs: time.optional(), durationUs: time.positive().optional(), fontSize: z.number().int().min(10).max(300).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), positionX: z.number().min(0).max(100).optional(), positionY: z.number().min(0).max(100).optional(), background: z.boolean().optional() },
  delete_title: { titleId: id },
  add_marker: { markerId: id.optional(), timeUs: time, name: z.string().min(1).max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() },
  update_marker: { markerId: id, timeUs: time.optional(), name: z.string().min(1).max(200).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() },
  delete_marker: { markerId: id },
  add_track: { kind: z.enum(['video', 'audio']), trackId: id.optional(), name: z.string().min(1).max(100).optional(), index: z.number().int().nonnegative().optional() },
  update_track: { trackId: id, name: z.string().min(1).max(100).optional(), locked: z.boolean().optional(), muted: z.boolean().optional(), visible: z.boolean().optional() },
  delete_track: { trackId: id },
  add_clip: { mediaId: id, trackId: id, clipId: id.optional(), startUs: time, inUs: time.optional(), outUs: time.optional(), speedPercent: z.number().min(25).max(400).optional(), color: color.optional(), audio: audio.optional(), transform: transform.optional(), effects: effects.optional(), lut: z.object({ lutId: id, strength: z.number().min(0).max(1) }).nullable().optional() },
  move_clip: { clipId: id, trackId: id, startUs: time },
  trim_clip: { clipId: id, edge: z.enum(['start', 'end']), timeUs: time.describe('For start: absolute timeline position. For end: absolute source out-point, before speed adjustment.') },
  set_clip_source_range: { clipId: id, inUs: time, outUs: time },
  crossfade_clips: { firstClipId: id, secondClipId: id, durationUs: time.positive() },
  split_clip: { clipId: id, playheadUs: time },
  delete_clip: { clipId: id },
  ripple_delete_clip: { clipId: id, trackMode: z.enum(['selected_track', 'all_tracks']).default('selected_track') },
  apply_color_adjustment: { clipId: id, adjustment: color },
  apply_audio_adjustment: { clipId: id, adjustment: audio },
  apply_clip_speed: { clipId: id, speedPercent: z.number().min(25).max(400) },
  apply_transform: { clipId: id, transform },
  apply_effect_stack: { clipId: id, effects },
  apply_lut: { clipId: id, lutId: id.nullable(), strength: z.number().min(0).max(1) }
};
export const editingCommandSchema = z.discriminatedUnion('type', Object.entries(commandShapes).map(([type, shape]) => z.object({ type: z.literal(type), ...shape }).strict()));

const descriptions = {
  import_captions: 'Import timed caption cues as one undoable edit. Replace mode removes existing captions and preserves ordinary titles. For SRT/WebVTT text, use subtitles_import.',
  add_title: 'Add a plain-text title or caption overlay. Supports newlines. Font size is project pixels; positions range from 0% to 100%. Titles appear above all video tracks.',
  update_title: 'Edit a title or caption text, timing, color, font size, position, or background.',
  delete_title: 'Delete a title or caption overlay. Undo restores it.',
  add_marker: 'Add a named, colored timeline marker. Saved with the project and undoable.',
  update_marker: 'Rename, recolor, or move a timeline marker.',
  delete_marker: 'Remove a timeline marker. Undo restores it.',
  add_track: 'Add a video or audio track. Returns the timeline with its new track ID.',
  update_track: 'Rename, lock, mute, or show/hide a track.',
  delete_track: 'Delete an unlocked track and its clips. Undo restores them.',
  add_clip: 'Place imported media on a compatible unlocked track. Times are microseconds; in/out are source positions. Video clips retain their audio by default.',
  move_clip: 'Move a clip to a timeline position or another track of the same kind.',
  trim_clip: 'Trim a clip within its source bounds. Start uses absolute TIMELINE time; end uses absolute SOURCE time. Speed is accounted for by the engine.',
  set_clip_source_range: 'Set source in/out while keeping the timeline start fixed. Changing their difference changes duration; shifting both equally slips the source without moving the clip.',
  crossfade_clips: 'Crossfade two adjacent clips on the same unlocked video track. Overlaps the second clip by durationUs, fades its video in and both clips’ audio, and shifts later clips on that track earlier. One undo restores the sequence.',
  split_clip: 'Split a clip at an absolute timeline time, preserving speed, effects, and audio.',
  delete_clip: 'Remove a clip while preserving the empty space. Undo restores it.',
  ripple_delete_clip: 'Delete a clip and close its duration on selected/all tracks. Clips crossing the removed span are preserved; downstream clips shift. Locked affected tracks reject the operation.',
  apply_color_adjustment: 'Adjust clip brightness, contrast, saturation, temperature, or tint.',
  apply_audio_adjustment: 'Set gain, fades, mute, normalization, cleanup, and source audio stream.',
  apply_clip_speed: 'Change source playback speed, from 25% to 400%. This changes clip duration.',
  apply_transform: 'Set scale, position in pixels, rotation in degrees, and opacity (0–1).',
  apply_effect_stack: 'Replace the effect stack. Read current effects first to preserve desired entries.',
  apply_lut: 'Apply a built-in look (filmic, warm, cool, mono) or remove it with null.'
};

export function createEditorMcpServer(rpc) {
  const server = new McpServer({ name: 'ai-video-editor', version: '0.1.0' }, {
    instructions: 'Control the project currently open in AI Video Editor. Start with editor_state. Use IDs from returned state. All times are integer microseconds. Commands respect track locks and use undo history. Use edit_batch for compound edits and propose_edits for review. Inspect timeline_frame after visual edits; it includes the export composition. Source images from media_frame do not include timeline effects. Frame images cannot verify motion or audio. Export is asynchronous: poll export_status until completed/failed/cancelled. Never claim a file was exported merely because export_start returned. If an operation times out, inspect state before retrying.'
  });
  const register = (name, description, inputSchema, method, map = (args) => args, readOnly = false, destructive = false) => {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false } }, async (args) => {
      try {
        const result = await rpc(method, map(args));
        if (result?.ok === false || result?.state === 'failed' || result?.state === 'error') return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }] };
        if (result?.dataUrl) {
          const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(result.dataUrl);
          if (!match) throw new Error('Editor returned an invalid frame.');
          return { content: [{ type: 'image', mimeType: match[1], data: match[2] }, { type: 'text', text: JSON.stringify({ ...result, dataUrl: undefined }) }] };
        }
        const output = result !== null && typeof result === 'object' && !Array.isArray(result) ? result : { result };
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
    });
  };
  register('editor_state', 'Read the current project, settings, media, timeline, playhead and undo history. Start here.', {}, 'editor.state', undefined, true);
  register('project_create', 'Create a project in a new/empty folder and open it in the editor. Saves the current project first. Set remember:false for temporary projects that should stay out of the recent-project list.', { path: z.string().min(1), name: z.string().min(1).max(200), remember:z.boolean().optional() }, 'project.create');
  register('project_open', 'Open an existing project folder. Saves the current project first. Set remember:false to skip the recent-project list.', { path: z.string().min(1), remember:z.boolean().optional() }, 'project.open');
  register('project_save', 'Save the current project.', {}, 'project.save');
  register('project_settings', 'Update project dimensions, frame rate, color mode, or master audio settings.', { width: z.number().int().min(16).max(8192).optional(), height: z.number().int().min(16).max(8192).optional(), fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(), colorMode: z.enum(['SDR', 'HDR']).optional(), audioEnabled: z.boolean().optional(), masterGainDb: z.number().min(-60).max(12).optional(), normalizeAudio: z.boolean().optional(), cleanupAudio: z.boolean().optional() }, 'project.settings');
  register('media_list', 'List imported media IDs, metadata, and paths.', {}, 'media.index', undefined, true);
  register('media_check', 'Check which imported source files are missing. Returns media IDs and paths so missing sources can be repaired with media_relink. Does not probe or modify files.', {}, 'media.check', undefined, true);
  register('media_probe', 'Read metadata from a local source file without importing it.', { path: z.string().min(1) }, 'media.probe', undefined, true);
  register('media_import', 'Import local video/audio files into the current project.', { paths: z.array(z.string().min(1)).min(1).max(100), copyToProject: z.boolean().default(false) }, 'command.execute', (args) => ({ type: 'import_media', ...args }));
  register('media_remove', 'Remove imported media and its linked clips from the project. Does not delete the source file. Undo restores the references.', { mediaId: id }, 'command.execute', (args) => ({ type: 'remove_media', ...args }), false, true);
  register('media_relink', 'Replace the source of an imported media ID while preserving clips, timing, and edits. Validates source duration, kind, required audio streams, and track locks. One undo restores the old reference; no source file is changed.', {mediaId:id,path:z.string().min(1)}, 'command.execute', (args)=>({type:'relink_media',...args}));
  register('media_frame', 'Inspect a decoded source frame from an imported video. Does not include timeline color/effects.', { mediaId: id, timeUs: time.default(0) }, 'media.frame', undefined, true);
  register('timeline_state', 'Read all tracks and clips, including timing, effects, speed and audio.', {}, 'timeline.state', undefined, true);
  register('timeline_frame', 'Inspect the rendered timeline composition: visible layers, transforms, fades, color, effects, titles and captions. Defaults to the current playhead; the returned image is sampled on the project frame grid. Uses the export filters and contains no audio.', {timeUs:time.optional(),maxWidth:z.number().int().min(16).max(4096).default(1280)}, 'timeline.frame', undefined, true);
  register('subtitles_import', 'Parse UTF-8 SRT or WebVTT content and import editable captions as one undo step. Validates the entire file; optional signed offset must leave all cue times nonnegative. Replace mode preserves ordinary titles. Returns warnings for unsupported styling.', {content:z.string().min(1).max(2*1024*1024),format:z.enum(['srt','vtt']),offsetUs:z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).default(0),mode:z.enum(['append','replace']).default('append')}, 'subtitles.import');
  register('subtitles_export', 'Return SRT or WebVTT text for caption overlays only. Optionally save to a local .srt/.vtt path; overwrite defaults to false. Includes timing/text, not editor styling.', {format:z.enum(['srt','vtt']),path:z.string().min(1).optional(),overwrite:z.boolean().default(false)}, 'subtitles.export');
  for (const [type, shape] of Object.entries(commandShapes)) register(type, descriptions[type], shape, 'command.execute', (args) => ({ type, ...args }), false, ['delete_clip', 'delete_track', 'ripple_delete_clip'].includes(type));
  register('edit_batch', 'Apply 1–500 timeline commands atomically with one Undo. If any fails, the entire batch is rolled back. No nested batches or import/export.', { label: z.string().max(200).optional(), commands: z.array(editingCommandSchema).min(1).max(500) }, 'command.execute', (args) => ({ type: 'execute_batch', ...args }));
  register('undo', 'Undo the latest edit or entire batch.', {}, 'command.undo');
  register('redo', 'Redo the latest undone edit or batch.', {}, 'command.redo');
  register('history', 'Read undo/redo availability and counts.', {}, 'command.history', undefined, true);
  register('playback', 'Seek or play/pause the visible editor preview.', { timeUs: time.optional(), playing: z.boolean().optional() }, 'editor.playback');
  register('playback_render', 'Render a cached SDR movie of the current timeline using export effects and the complete audio mix. Returns a job ID immediately; poll playback_render_status for a local H.264/AAC path. Does not change history or the visible playback mode. Source/settings changes invalidate cache reuse.', {maxWidth:z.number().int().min(16).max(4096).multipleOf(2).default(1280)}, 'playback.render');
  register('playback_render_status', 'Read playback render progress or the completed review movie path. Jobs are temporary and belong to this desktop session.', {jobId:id}, 'playback.render_status', undefined, true);
  register('playback_render_cancel', 'Cancel a queued or running playback render and remove its incomplete temporary files. Completed cached movies are retained.', {jobId:id}, 'playback.render_cancel');
  register('export_start', 'Render the current timeline or an optional time range to a local file. Range bounds use timeline microseconds. Uses project settings unless overridden. Poll export_status for completion; overwrite defaults to false.', { outputPath: z.string().min(1), rangeStartUs: time.optional(), rangeEndUs: time.optional(), codec: z.enum(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc']).optional(), container: z.enum(['mp4', 'mkv']).optional(), quality: z.enum(['trash', 'low', 'medium', 'high', 'pro_max']).optional(), bitrateMbps: z.number().int().min(1).max(2000).optional(), overwrite: z.boolean().default(false) }, 'export.start');
  register('export_status', 'Read render progress, destination, errors, and completion status.', {}, 'export.status', undefined, true);
  register('export_cancel', 'Cancel the current render.', {}, 'export.cancel');
  register('propose_edits', 'Queue a reviewable proposal without changing the timeline. The user can inspect/apply it in AI & Agents.', { goal: z.string().min(1).max(500), explanation: z.string().max(4000), commands: z.array(editingCommandSchema).min(1).max(500) }, 'ai.proposal.create');
  register('proposals_list', 'List pending and past edit proposals.', {}, 'ai.proposals', undefined, true);
  register('proposal_apply', 'Apply a pending proposal atomically, with one undo entry. Use when applying has been authorized.', { proposalId: id }, 'ai.proposal.apply');
  register('proposal_reject', 'Reject a pending proposal without editing clips.', { proposalId: id }, 'ai.proposal.reject');
  const pluginScope = z.enum(['project', 'user']).default('project');
  register('plugins_list', 'List installed plugins, permissions, enabled state, and errors. Project scope is local to the current project; user scope applies across projects.', { scope: pluginScope }, 'plugin.list', undefined, true);
  register('plugin_inspect', 'Inspect a local plugin package folder before installing it. Does not execute plugin code.', { folder: z.string().min(1) }, 'plugin.inspect', undefined, true);
  register('plugin_install', 'Copy a plugin package into the selected location. Starts disabled. An update also disables the plugin until its new permissions/code are reviewed.', { folder: z.string().min(1), scope: pluginScope, replace: z.boolean().default(false) }, 'plugin.install');
  register('plugin_enable', 'Enable or disable an installed plugin after inspecting its permissions. Native plugins also require developer mode.', { pluginId: id, scope: pluginScope, enabled: z.boolean() }, 'plugin.enable');
  register('plugin_run', 'Run an enabled plugin. Returns output, logs, and a pending proposal for edits; it does not apply edits. Use proposal_apply to apply reviewed commands.', { pluginId: id, scope: pluginScope, parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional() }, 'plugin.run');
  register('plugin_remove', 'Uninstall an editor plugin from the selected location. Applied timeline edits remain.', { pluginId: id, scope: pluginScope }, 'plugin.remove', undefined, false, true);
  register('plugin_developer_mode', 'Allow or block native C++ plugin execution in the selected location. Native DLLs have the same operating-system access as the editor; enable only for trusted plugins.', { scope: pluginScope, enabled: z.boolean() }, 'plugin.developer_mode');
  for (const [name, method] of [['project', 'editor.state'], ['timeline', 'timeline.state'], ['media', 'media.index']]) {
    server.registerResource(name, `video-editor://${name}`, { mimeType: 'application/json', description: `Live editor ${name}` }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await rpc(method)) }] }));
  }
  server.registerPrompt('edit_video', { description: 'Plan and carry out a video edit using the current project.', argsSchema: { goal: z.string() } }, ({ goal }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Editing goal: ${goal}\nRead editor_state and inspect source frames as needed. Use existing media IDs and preserve track locks. Explain the proposed changes, use atomic batches or a proposal, and verify the resulting timeline with timeline_frame at relevant edit boundaries. Frame images cannot verify motion or audio. Export only when requested and check completion status.` } }] }));
  return server;
}
