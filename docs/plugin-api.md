# Plugin API

Plugins are project-local or app-installed extensions with explicit manifests and permissions.

## Manifest

```json
{
  "id": "example.plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "type": "typescript",
  "entry": "main.js",
  "permissions": ["timeline.read", "timeline.write", "ui.command"]
}
```

## Permissions

- `timeline.read`
- `timeline.write`
- `media.read`
- `media.import`
- `project.read`
- `project.write`
- `export.create`
- `ui.panel`
- `ui.command`
- `color.write`
- `filesystem.projectOnly`

## TypeScript Plugins

TypeScript plugins are intended for UI panels, commands, workflow helpers, export presets, metadata tools, and simple automation.

## C++ Plugins

C++ plugins are dev-only in v0.1. They must be Windows DLL files, require developer mode, and should be disabled by default per project.
