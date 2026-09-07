# Command system

The desktop and MCP server use the same engine command path. Editing commands return an updated timeline or project snapshot, plus undo/redo counts. The UI applies that result before accepting the next agent request.

## JSON-RPC

```json
{
  "jsonrpc": "2.0",
  "id": "request_uuid",
  "method": "command.execute",
  "params": {
    "type": "ripple_delete_clip",
    "clipId": "clip_001",
    "trackMode": "selected_track"
  }
}
```

For the complete typed contract see `packages/protocol/src/commands.ts`; discoverable MCP input schemas live in `packages/mcp/src/server.mjs`. See [MCP setup and usage](mcp.md) for agent connection instructions.

## Editing operations

| Area | Commands |
| --- | --- |
| Media | `import_media`, `relink_media`, `remove_media` |
| Tracks | `add_track`, `update_track`, `delete_track` |
| Clip placement | `add_clip`, `move_clip`, `split_clip`, `delete_clip`, `ripple_delete_clip` |
| Source and timing | `trim_clip`, `set_clip_source_range`, `apply_clip_speed`, `crossfade_clips` |
| Appearance | `apply_color_adjustment`, `apply_lut`, `apply_transform`, `apply_effect_stack` |
| Audio | `apply_audio_adjustment` |
| Markers | `add_marker`, `update_marker`, `delete_marker` |
| Titles and captions | `add_title`, `update_title`, `delete_title`, `import_captions` |
| Project | `update_project_settings` |
| Compound edits | `execute_batch` |

Times are integer microseconds. `startUs` is timeline time; `inUs` and `outUs` are source time. At 200% speed, four seconds of source occupies two seconds on the timeline. Start-edge trimming accepts timeline time; end-edge trimming accepts source time. Use `set_clip_source_range` to change source points without moving the clip.

Track locks protect clip edits, track deletion, and removal of media used on that track. Playback is unaffected by locks. Ripple deletion across all tracks rejects an operation that would shift clips on a locked track.

`relink_media` takes `mediaId` and `path`, preserves the existing clip references and edits, and validates source kind, duration, required audio streams, and track locks. Import rejects unavailable or unusable sources atomically. `copyToProject: true` imports independent copies; undo removes references but retains copied files for redo. Duplicate paths and aliases within one request import once.

Fade durations use timeline time after speed adjustment. Splits preserve the original envelope through optional `fadeOffsetUs` and `fadeDurationUs` fields in audio/transform data. Preserve these fields when copying clips. Zero duration uses the current clip. Fade-length edits reanchor the affected audio/video envelope; trims, source-range edits, speed edits, and crossfades reanchor both. Other edits retain the envelope.

Text overlays have `kind: "title"` (the default for older projects) or `"caption"`. `import_captions` takes 1–5,000 `{text, startUs, durationUs}` cues, optional `mode: "append" | "replace"`, and optional `style` (font size, color, position, background). Replace mode preserves ordinary titles. The entire import is one undo step, including for more than 500 cues. Caption text is limited to 4,000 UTF-8 bytes per cue. [Subtitle interchange](subtitles.md) parses SRT/WebVTT into this command.

## Transactions and undo

The engine owns the history, capped at 200 entries per open session. `command.undo`, `command.redo`, and `command.history` restore or inspect that history. Undo is retained across saves and reset on project open. Project dimensions, frame rate, and audio settings are undoable commands.

`execute_batch` accepts 1–500 editing commands. It commits as one undo entry, or restores both database and memory on failure. Nested batches, media import/relink/removal, project settings, and exports are excluded. Media operations have their own transactions.

AI proposals validate their commands without applying them. Applying a proposal uses one batch; undo restores both the original edit state and the pending proposal. Proposal rejection changes proposal status without editing clips.

Continuous UI adjustments coalesce changes to the same control; changing controls or pausing the gesture creates a separate undo group. Reset Color and Reset Effects each use one batch.

## Project persistence

`project.create`, `project.open`, `project.state`, and `project.save_state` manage the current session. Snapshot replacement is transactional. Opening a missing or malformed database preserves the previous connection, state, and history. The desktop saves the current project before switching, and snapshots belonging to another project are rejected.

## Export jobs

Use `export.start`, `export.status`, and `export.cancel` for asynchronous rendering. `export_timeline` remains a command entry point. Optional `rangeStartUs` and `rangeEndUs` bound the output interval. A status-query failure is not proof that the render failed; reconnect and inspect the job status.
