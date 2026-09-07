# Plugin API

The desktop Plugins tab installs local packages, displays permissions and errors, and runs enabled plugins. A run returns text and optionally a pending edit proposal. **Apply edits** validates and applies the proposal atomically as one undo step. Running a plugin alone does not change the timeline.

## Install and run

Choose **This project** or **All projects**, then **Install package** and select a folder containing `plugin.json`. Review the manifest, install, enable, and run it. Project packages live in `<project>/plugins/<id>`; user packages live in `%LOCALAPPDATA%/AI Video Editor/plugins/<id>`. Updates start disabled. Changed package contents invalidate approval, and a failed or cancelled run disables the package with an error message. Uninstalling a package preserves already applied edits.

## Manifest

```json
{
  "id": "example.markers",
  "name": "Chapter markers",
  "version": "1.0.0",
  "description": "Propose a chapter marker at each clip start.",
  "type": "typescript",
  "entry": "main.js",
  "permissions": ["timeline.read", "timeline.write", "ui.command"],
  "parameters": [
    {"id": "prefix", "label": "Marker prefix", "type": "string", "default": "Chapter", "required": true}
  ]
}
```

`type: "typescript"` loads compiled JavaScript ES modules (`.js` or `.mjs`). Compile TypeScript before installation. Relative imports between packaged modules work; bundle dependencies that use bare npm imports. Package paths must stay inside the folder, without symlinks or junctions. Limits are 64 MB, 1,000 files, 16 directory levels, and 2 MB per JavaScript module. IDs use lowercase letters, digits, dots, underscores, and hyphens, starting with a letter or digit (maximum 80 characters).

Up to 20 parameters can be declared with unique `id`, `label`, and `type` (`string`, `number`, or `boolean`). Optional fields include `default`, `required`, numeric `min`/`max`/positive `step`, and string `options`. The UI builds controls from these declarations. The runtime validates parameters before invoking the plugin. See the [manifest schema](../packages/protocol/schemas/plugin-manifest.schema.json).

## Context and permissions

| Permission | Contract |
| --- | --- |
| `timeline.read` | Supplies the current `context.timeline`, including tracks, clips, titles, and markers. |
| `media.read` | Supplies `context.media` metadata and source paths. It does not grant file access. |
| `project.read` | Supplies `context.project` and `context.projectSettings`. |
| `timeline.write` | Allows proposed track, clip, marker, title, color, sound, and effect commands. |
| `color.write` | Allows proposed `apply_color_adjustment` and `apply_lut` commands. |
| `ui.command` | Declares a command exposed through the standard Run controls. |
| `ui.panel` | Declares text output shown in the standard result panel. Custom HTML panels are not supported. |

Read permissions are independent of write permissions. Unrequested context fields are absent. All plugins receive `apiVersion: 1`, `playheadUs`, validated `parameters`, and, in JavaScript, `log(message, level?)`. Levels are `info`, `warning`, and `error`; console log/warn/error are captured too. The typed contract is in [@ai-video-editor/plugin-sdk](../packages/plugin-sdk/index.d.ts).

```js
export default function run(context) {
  context.log('Preparing a marker');
  return {
    summary: 'Add a marker at the playhead.',
    output: 'Review the proposed position before applying.',
    commands: [{type: 'add_marker', timeUs: context.playheadUs, name: context.parameters.prefix}]
  };
}
```

The default export may be async. Results contain `summary`, optional plain-text `output`, and optional `commands`. Times are integer microseconds. Commands use the [editor command contract](commands.md); import/removal of media, export, project settings, nested batches, and history overrides are excluded. A result may contain at most 500 commands; input/output JSON is limited to 2 MB. Logs retain up to 200 messages of 2,000 characters. Proposed commands are checked against permissions and validated by the engine before entering the review queue.

JavaScript executes in a worker on a separate temporary loopback origin, isolated from the editor DOM, Tauri bridge, and browser storage. The content policy blocks network requests and imports outside the package. A run is terminated after five seconds; Cancel terminates its worker. This API supports short editing helpers, not long-running rendering or background services.

The working [clip-markers example](../examples/plugins/clip-markers) reads timeline/media metadata and proposes named markers using a relative module import.

## Native C++ plugins

Native packages use `type: "cpp"` and a 64-bit Windows `.dll` entry. Enable **Native development** separately for the chosen install location before enabling or running one. This requirement applies regardless of the manifest's optional `developerModeRequired` flag.

Native DLLs have the same operating-system file and network access as the editor. Permissions control supplied context and accepted proposals; they do not sandbox native code. Each invocation uses a separate engine process, with a five-second timeout and a 2 MB output limit. A process exit or hang is reported and disables the plugin while preserving the desktop editing session. Cancel discards the result; the host process may take up to the time limit to exit.

Implement all three exports from [editor_plugin.h](../packages/plugin-sdk/native/editor_plugin.h):

```cpp
int ai_video_plugin_version();                    // Return 1
const char* ai_video_plugin_run(const char* json); // UTF-8 context to UTF-8 result JSON
void ai_video_plugin_free(const char* result);    // Free using the same DLL allocator
```

The result string must remain valid until `ai_video_plugin_free` is called. Native context contains data only; use the result's `output` for diagnostics. See the [native-title example](../examples/plugins/native-title/main.cpp). With the engine configured and testing enabled, build it with `cmake --build engine/build --config Debug --target native-title-plugin`; install `engine/build/plugins/native-title`.

## Agents and regression checks

MCP exposes `plugins_list`, `plugin_inspect`, `plugin_install`, `plugin_enable`, `plugin_run`, `plugin_remove`, and `plugin_developer_mode`. Each scoped operation accepts `scope: "project"` (default) or `"user"`. `plugin_run` returns a proposal; use `proposal_apply` separately after review. See [MCP setup](mcp.md).

The Rust suite covers install validation, approval invalidation, and native mode gating. `node packages/mcp/test/live-plugins.mjs` requires a fresh desktop session with agent access and no project open. Build `native-title-plugin` and `native-plugin-fault` first. The script creates its own project and checks JavaScript module loading, permission filtering, network denial, worker timeout, tampering, native process exit/timeout, and proposal Apply/Undo.
