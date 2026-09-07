# Connect an AI agent

The editor provides a standard MCP server over stdio. Any MCP client that can launch a local Node process can connect. The server operates on the project open in the desktop window, through the same command engine and undo history as manual editing.

## Setup

1. Install the repository dependencies with `corepack pnpm install`.
2. Start the desktop editor with `corepack pnpm dev`.
3. Open **AI & Agents** and enable **Agent access** once. The editor remembers this setting and reconnects automatically on later launches.
4. The editor registers `video-editor` in Codex's shared MCP configuration automatically on startup. Restart Codex after the first registration, then ask it to call `editor_state`. Keep the editor running.

Installed desktop builds include the MCP server and a Node runtime; they do not need a checkout or Node on the client's PATH. Development builds resolve the local source and an absolute Node executable path. Both use the same discovery and registration flow.

### Codex discovery

Registration uses `$CODEX_HOME/config.toml` when `CODEX_HOME` is set, otherwise `~/.codex/config.toml`. This is the [shared MCP configuration used by the desktop app, CLI, and IDE extension](https://learn.chatgpt.com/docs/extend/mcp). The editor refreshes its launch paths on startup and when access is enabled. Registration preserves other servers, explicit `enabled = false`, tool policies, and custom timeouts. An unrelated server already named `video-editor` is left unchanged and reported in the editor.

The **Codex app** status in **AI & Agents** shows registration separately from editor access. Use **Refresh Codex registration** after fixing a configuration error or changing the Node installation. If Codex has disabled the server, enable it in Codex's MCP settings. A registration error does not prevent the editor from opening or connecting through another client.

The MCP process starts and lists its tools even while the editor is closed. Each tool call re-reads the bridge discovery file, so an existing Codex connection picks up the new session and token when the editor restarts. No port or token needs to be copied. If several editor windows enable access, the most recently enabled window is discovered.

### Other MCP clients

Open **Connect another MCP client** and copy the generated JSON. An example configuration is below. Replace the checkout path with your own absolute path; the editor's Copy configuration button fills the executable, server, and discovery paths automatically.

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["C:/path/to/VideoEditor/packages/mcp/src/index.mjs"]
    }
  }
}
```

The hand-written example assumes Node is on the client's PATH. The generated configuration uses an absolute executable path instead. `corepack pnpm mcp` starts the stdio entry point for development. `corepack pnpm mcp:build` bundles the server, its dependencies, and the current Node executable into the desktop resources; Tauri's development and build hooks run this automatically.

The desktop bridge is disabled until first enabled. It binds only to `127.0.0.1` on a random port, authenticates requests with a per-session token, rejects browser origins, and exposes only editor operations. The stdio server discovers the bridge through `%LOCALAPPDATA%/AI Video Editor/agent-bridge.json`. To use a custom location, set `AI_VIDEO_EDITOR_BRIDGE_FILE` to an absolute path when starting the desktop editor; generated client configurations use that same path. The remembered access setting lives alongside the bridge file as `agent-bridge.preferences.json` (or `<custom-name>.preferences.json`). Do not copy the bridge token into prompts or source control. Closing the editor or disabling access invalidates the session. Closing preserves the remembered preference; disabling prevents reconnection on later launches. Explicitly launching the desktop executable with `--agent-access` enables it for that launch without changing the saved preference.

## Available operations

| Area | Tools |
| --- | --- |
| Project | `editor_state`, `project_create`, `project_open`, `project_save`, `project_settings` |
| Media | `media_list`, `media_check`, `media_probe`, `media_import`, `media_relink`, `media_remove`, `media_frame` |
| Tracks | `add_track`, `update_track`, `delete_track`, `timeline_state` |
| Composition inspection | `timeline_frame` |
| Clips | `add_clip`, `move_clip`, `trim_clip`, `set_clip_source_range`, `split_clip`, `delete_clip`, `ripple_delete_clip`, `crossfade_clips` |
| Look and sound | `apply_color_adjustment`, `apply_audio_adjustment`, `apply_clip_speed`, `apply_transform`, `apply_effect_stack`, `apply_lut` |
| Markers and text | `add_marker`, `update_marker`, `delete_marker`, `add_title`, `update_title`, `delete_title` |
| Captions | `import_captions`, `subtitles_import`, `subtitles_export` |
| History | `edit_batch`, `undo`, `redo`, `history` |
| Playback and delivery | `playback`, `export_start`, `export_status`, `export_cancel` |
| Review | `propose_edits`, `proposals_list`, `proposal_apply`, `proposal_reject` |
| Plugins | `plugins_list`, `plugin_inspect`, `plugin_install`, `plugin_enable`, `plugin_run`, `plugin_remove`, `plugin_developer_mode` |

The server also provides JSON resources at `video-editor://project`, `video-editor://timeline`, and `video-editor://media`, plus the `edit_video` prompt. Discover the tool schemas through MCP for supported values and limits.

`media_import` probes every source and rolls back the entire request if a file is missing, corrupt, or incompatible. Use `copyToProject: true` to keep independent copies under the project's `media` folder. Undo removes imported references but keeps copied files on disk so redo and saved snapshots remain usable. Ordinary imports reference the original files. `project_create` and `project_open` accept `remember: false` for temporary projects that should stay out of the recent-project list, including later autosaves.

For missing media, call `media_check`, then `media_relink` with the existing media ID and replacement path. Relinking preserves clip IDs, timing, edits, and the bin name, and creates one undo entry. The replacement must cover all referenced source ranges, preserve required audio streams, and match the media kind. Locked tracks prevent relinking their sources. `media_check` checks file availability; use `media_probe` for stream validation.

Plugin operations use `scope: "project"` by default; `"user"` applies across projects. Inspect a package's permissions before enabling it. `plugin_run` returns output and a pending proposal, with application performed separately through `proposal_apply`. Native DLLs require developer mode and have operating-system access. See the [plugin contract](plugin-api.md) for supported permissions, examples, and limits.

## Timing and editing rules

- All times are integer microseconds: one second is `1000000`.
- `editor_state.contentDurationUs` ends at the last clip or title. `timeline.durationUs` also includes spare room for editing and markers; playback stops at the content end.
- `startUs` is a position on the timeline. `inUs` and `outUs` are positions in the source file. Display duration is `(outUs - inUs) / (speedPercent / 100)`.
- `trim_clip` with `edge: "start"` takes an absolute **timeline** time. With `edge: "end"`, it takes an absolute **source** time. `set_clip_source_range` changes source points while preserving the timeline start; shifting both equally slips the source.
- Smaller track indexes render above larger indexes. Later-starting clips render above earlier clips on the same track. Track locks prevent edits but do not disable playback.
- Crossfades require adjacent clips on the same video track. They overlap the next clip and move subsequent clips on that track earlier. Other tracks retain their positions.
- Audio and video fades use timeline time, after speed adjustment. Splitting preserves the original fade progression, including a cut inside a fade. Serialized audio/transform objects may contain `fadeOffsetUs` and `fadeDurationUs`; preserve these when copying clips. A zero duration anchors fades to the current clip. Changing fade lengths reanchors that audio or video fade to the segment; trims, source-range changes, speed changes, and crossfades reanchor both. Gain, transform position, and timeline moves preserve the range.
- Titles render above video layers. They accept plain text and line breaks, with font size in project pixels and positions in percentages. Still images default to five seconds and can be extended.
- Text overlays marked `kind: "caption"` are included in subtitle exports. `subtitles_import` takes SRT/WebVTT text, a format, an optional signed offset, and append/replace mode. Replacement preserves ordinary titles. `subtitles_export` returns text and optionally writes a `.srt`/`.vtt` file, with overwrite disabled by default. See [subtitle interchange](subtitles.md).
- `edit_batch` accepts 1–500 editing commands. It succeeds atomically with one undo entry or rolls back the entire batch. Import, relinking, media removal, settings, nested batches, and export cannot be included.
- `propose_edits` validates commands and stores a pending proposal without editing the timeline. Applying it creates one undo entry; undo also restores its pending status.
- Reads and writes may return a busy error while the user has a modal open or an edit is running. A busy error means no action was taken. After a timeout, inspect state before retrying a mutation; the outcome may be uncertain.

## Export and verification

`export_start` returns a job, not a completed file. Poll `export_status` until `completed`, `error`, or `cancelled`. Inspect logs on failure. The optional `rangeStartUs` and `rangeEndUs` select a timeline interval; output time starts at zero. The default duration follows visible video and titles, or audible clips when no visual content exists. Long background audio is trimmed to the visual sequence. Overwrite is false unless explicitly requested.

Exports use the installed NVIDIA/FFmpeg pipeline. The editor retries hardware decoding with CPU decoding when necessary and records FFmpeg diagnostics. Source-frame inspection with `media_frame` returns the original source, before timeline transforms, titles, or effects. It must not be used as proof of final output appearance. Verify the actual exported file when appearance or audio matters.

Use `timeline_frame` after visual edits to inspect the composed timeline, including visible layers, color, looks, effects, transforms, fades, titles, and captions. It returns an MCP image plus the sampled timeline time, image dimensions, and cache status. `timeUs` defaults to the current playhead without moving it; times are sampled on the project's frame grid. `maxWidth` defaults to 1280 and accepts 16–4096, preserving aspect ratio without upscaling. Frame inspection is read-only and creates no history entries.

The paused desktop monitor uses this same export filter graph. Changing the timeline or source file invalidates cached frames; rapid seeking cancels outdated monitor requests. Rendering is limited to two concurrent processes, 15 seconds per frame, and a 128 MB/256-frame cache. These frames are 8-bit images and do not verify HDR display, motion, encoded-file quality, or audio. Current interactive playback uses a draft preview; check an export for final motion and sound.

## Regression checks

`node packages/mcp/test/live-readonly.mjs` checks discovery and live read-only tools against the open editor without creating a project or changing undo history. To check the exact Node executable and server bundle registered with Codex, run `codex mcp get video-editor --json | node packages/mcp/test/live-readonly.mjs --codex-config-stdin`. It checks composed-frame output only when a project with timeline content is already open; otherwise it reports that check as skipped. Launch paths are normalized for Node compatibility on Windows, including Tauri resource paths that use the verbatim `\\?\` prefix.

`corepack pnpm mcp:test` runs protocol discovery, validation, error handling, loopback authentication, and real stdio transport checks. `node packages/mcp/test/live-editor.mjs` is an explicit integration check requiring a fresh desktop window with agent access enabled and no project open. It creates its own synthetic media and projects under `engine/build`, exercises live edits and undo, and checks exported frames and metadata. It refuses to replace an existing open project.

`node packages/mcp/test/live-composition.mjs` has the same fresh-window requirement. It compares composition frames with decoded exports for color, every current effect and look, layered transforms/fades, title text, and speed-adjusted motion. It also checks source-file cache invalidation, look strength, image sizing, and history preservation. Artifacts and comparison metrics are saved under `engine/build/mcp-composition-*`.

`node packages/mcp/test/live-media-recovery.mjs` checks real source validation, Unicode paths, moved files, relink rollback and undo, project copies, save/reopen, and export. `node packages/mcp/test/live-split-fades.mjs` compares paused frames and decoded video/audio before and after repeated splits at normal and double speed with mono/stereo sources. The split check accepts a fresh window or one of its own previous fixtures. These checks use temporary projects with `remember: false`.
