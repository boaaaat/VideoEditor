# Architecture

AI Video Editor v0.1 is split into four layers:

1. React + TypeScript UI in `apps/desktop/src`
2. Tauri shell in `apps/desktop/src-tauri`
3. C++ engine sidecar in `engine/src`
4. Shared protocol package in `packages/protocol`

The UI never edits project data directly. It sends commands to the engine through Tauri. Tauri launches `ai-video-engine.exe` and exchanges line-delimited JSON-RPC over stdin/stdout.

## Runtime Flow

```text
React UI
  -> Tauri command: engine_rpc(method, params)
  -> C++ sidecar JSON-RPC
  -> EngineApp
  -> CommandRegistry / ProjectManager / MediaImporter / TimelineService
  -> JSON-RPC result
```

Playback control also uses JSON-RPC. Preview frames are reserved for a local stream at `http://127.0.0.1:47110/preview`.

## Boundaries

- UI owns layout, tabs, inspector controls, shortcut capture, and command palette display.
- Tauri owns file dialogs, process launch, app packaging, and safe bridge commands.
- C++ owns projects, SQLite, command validation, timeline mutation, media/export/playback services, plugins, undo/redo, and future AI approval primitives.
- Protocol owns shared TypeScript types and JSON schemas for commands, manifests, and plugin metadata.

## v0.1 Phases

The repository is scaffolded so each phase can be implemented without moving files:

1. Shell and backend connection
2. Project and import
3. Timeline
4. Playback
5. Export
6. Color and LUTs
7. Plugin foundation
8. Future AI placeholder
