# Project Format

Projects are folders. The small manifest describes the project, and SQLite stores the real editing data.

```text
MyProject/
  project.aivproj
  project.db
  media/
  proxies/
  thumbnails/
  waveforms/
  cache/
  luts/
  plugins/
  exports/
```

## Manifest

```json
{
  "version": 1,
  "name": "My Project",
  "database": "project.db",
  "createdWith": "AI Video Editor v0.1"
}
```

## Database Ownership

The C++ engine is the only writer for `project.db`. UI state is a read model derived from engine responses and events.

## Media Import

The default import behavior links to original files. Copying media into `media/` can be added as an explicit command option.

Supported v0.1 imports:

- MP4
- MOV
- MKV
- MP3
