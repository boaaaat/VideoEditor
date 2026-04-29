# Command System

Every edit goes through a command. The command registry is the shared execution path for manual UI actions, keyboard shortcuts, plugins, and future AI workflows.

## JSON-RPC Shape

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

## Core Commands

- `import_media`
- `add_track`
- `delete_track`
- `add_clip`
- `move_clip`
- `trim_clip`
- `split_clip`
- `delete_clip`
- `ripple_delete_clip`
- `apply_color_adjustment`
- `apply_lut`
- `export_timeline`

## Undo and Redo

Commands are recorded by `CommandHistory`. Reversible commands should store enough before/after data for undo. Future AI auto-accept modes must create a restore point before applying commands.

The desktop UI also keeps a bounded read-model snapshot history so undo/redo works for the current editor surface while engine-side command history matures. Each media, timeline, project settings, and AI proposal state change records the previous visible state. Undo and redo restore those snapshots, mark the project dirty, and are saved through the normal project snapshot flow.

Current UI-backed undo/redo covers:

- adding, deleting, moving, trimming, splitting, nudging, and ripple-deleting clips
- removing media from the bin and restoring linked timeline clips through undo
- project settings changes
- AI proposal apply/reject state changes
