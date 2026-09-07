# Captions and subtitle interchange

Open **Titles and captions** in Edit, then expand **Import / export subtitles**. Choose a UTF-8 `.srt` or `.vtt` file, review the cue count and preview, set a timing offset if needed, and choose whether to append or replace existing captions. Import validates the entire file and creates one undo step. Replacement preserves ordinary titles. Up to 5,000 cues and 2 MB can be imported at once; each cue can contain up to 4,000 UTF-8 bytes.

Imported cues are editable text overlays with `kind: "caption"`. Select one in the title selector or timeline to change its text, timing, position, font, color, and background. Choose the Caption preset to mark a manually entered overlay as a caption. Older text overlays remain ordinary titles until explicitly changed.

**Export SRT** and **Export WebVTT** save caption text and timing, excluding ordinary titles. These sidecar files do not carry the editor's font, color, or background settings. Video exports render both captions and titles into the picture. Subtitle timestamps are rounded to milliseconds, with a minimum one-millisecond cue duration.

The parser supports optional cue identifiers, multiline text, overlapping cues, Unicode, UTF-8 BOMs, and Windows or Unix line endings. WebVTT requires its `WEBVTT` header and a blank line before cues. Timing rules follow the [W3C WebVTT specification](https://www.w3.org/TR/webvtt1/). A negative offset is allowed only if every resulting cue starts at or after zero.

This is plain-text interchange: inline style/speaker tags and karaoke timestamps are removed, text entities are decoded, and cue positioning is replaced with the editor's caption style. WebVTT comments are ignored; stylesheet, region, and header metadata are omitted. The import preview and MCP response report these conversions. Text and timing remain available for review before applying.

MCP clients can call `subtitles_import` with `content`, `format`, optional `offsetUs`, and `mode`; or supply timed cues directly through `import_captions`. `subtitles_export` returns `content` and `count`; an optional `path` writes the file, and `overwrite` defaults to false. A failed import preserves the timeline and undo history. See [MCP setup](mcp.md).

The protocol tests exercise parsing, malformed-file rejection, and multilingual round-trips. `node packages/mcp/test/live-subtitles.mjs` requires a fresh desktop session with agent access. It creates an isolated project and verifies undo/redo, persistence, file overwrite protection, caption pixels at the correct times, and export of a 501-cue sequence using a file for the large FFmpeg filter graph.
