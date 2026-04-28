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
