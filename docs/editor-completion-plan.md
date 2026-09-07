# Editor completion work

The active goal covers a polished, usable editor with complete basic editing workflows and an MCP interface usable by LLM agents. This checklist records the remaining scope; passing a subset of tests does not complete the goal.

## Implemented; verification in progress

- Editing inspector: source ranges, speed, gain/fades, transforms, video fades, and adjacent crossfades.
- Timeline: multi-selection, clipboard operations, snapping, markers, editable timecode, navigation, and resizable panels.
- Titles and still-image imports, layered exports, and export time ranges.
- Transactional compound commands, source/track validation, undoable settings, and failed-project-open safeguards.
- Shared layered previews in Edit, Color, and Effects; processed audio previews and content-end playback.
- Standard MCP stdio server with tool discovery, resources, proposal review, undo, export jobs, and synchronization through the live desktop session.
- Working plugin discovery, installation, approval, parameters, run results, error status, and proposal Apply/Undo in the UI and MCP. JavaScript worker isolation and native process failure recovery have live checks.
- SRT/WebVTT caption import/export, caption/title distinction, timing offsets, append/replace, and atomic imports of up to 5,000 cues. Long FFmpeg graphs use temporary files to avoid Windows command-line limits.
- Paused composition rendering shares export filters, with cancellable background processes, bounded atomic PNG caching, and MCP `timeline_frame` image inspection. Temperature/tint and partial-strength filmic/mono looks now respond correctly.
- Compact timeline toolbar, expandable media filters, vertical track scrolling over headers or with Alt+wheel, and bounded scrolling dialogs with keyboard focus handling.
- Real source validation, transactional relinking with undo, independent project-copy imports, and missing-source inspection through MCP. Temporary agent projects can skip the recent-project list through saves and autosaves.
- Splits preserve the original audio/video fade progression through repeated cuts. Fade timing in draft playback uses timeline time after speed adjustment. Export audio now assigns valid timestamps to delayed silence after source seeking.
- Settings now has project canvas/frame-rate/audio controls, persistent import-copy and autosave preferences, and links to shortcuts/plugins/agents. Media cards show availability and relevant proxy/error states; routine cache details remain in a tooltip.

## Required work remaining

- [ ] Finish visual review of the native editing workspace and its dialogs at supported window sizes; resolve layout and interaction issues.
- [ ] Complete visual preview fidelity. Paused SDR frames are implemented and compared with exports; final-quality motion playback, audio normalization parity, and HDR handling remain.
- [x] Replace the placeholder plugin UI with working discovery, install/enable/run/status/error flows and documented plugin contracts. Native visual review remains in the separate UI audit.
- [ ] Audit remaining basic editing workflows, including missing-media recovery and source validation, and fill functional gaps. Caption interchange is implemented and has live regression coverage.
- [ ] Complete AI workflow review. Agents can now inspect the resulting composition through `timeline_frame`; the final workflow audit remains.
- [ ] Update setup/feature documentation to describe actual capabilities and remaining limitations.
- [ ] Perform the final requirement-by-requirement build, regression, and live interaction audit.

## Current evidence (2026-09-05)

- The full `corepack pnpm test` pipeline passed after the media/fade phase: playback and bundle configuration, three schemas, five subtitle tests, nine MCP tests, ten Rust tests, and the rebuilt engine suite (45.20 seconds). Engine coverage now also includes real-media validation/copy rollback, relinking, fade ranges, duplicate import paths, and repeated-split undo/redo.
- Ten Rust tests passed, including plugin approval/native-mode checks, subtitle overwrite protection, audio normalization/cleanup, source-cache invalidation, still-image metadata on relink, and rejection of incomplete cached PNGs.
- Production frontend build and TypeScript checking passed during the composition/native layout phase. Playback and bundle configuration checks passed.
- Nine MCP SDK/stdio tests passed, including composition image content, defaults, media recovery routing, temporary-project options, and validation. Five subtitle parser/round-trip tests and all three JSON schemas passed in the media/fade phase.
- The latest broad live scenario passed 85 MCP calls, including project-open failure recovery, settings undo/redo, still playback, gap traversal, stopping at the content end, layered exports, title intervals, crossfade pixels, audio streams, and range timing. Poll counts vary with export completion time. Artifacts: `engine/build/mcp-live-1788595534776/report.json`.
- Plugin integration passed 56 calls, including relative module imports, blocked network access, context filtering, worker timeout, changed-package invalidation, native exit/timeout recovery, and proposal Apply/Undo. Artifacts: `engine/build/mcp-plugins-1788594434305/report.json`.
- Caption integration passed 41 calls, including Unicode round-trip, failed-import rollback, one-step undo, reopen persistence, subtitle file protection, correct rendered cue intervals, and a 501-cue video export. Artifacts: `engine/build/mcp-subtitles-1788595258453/report.json`.
- Composition integration passed 138 calls and 16 comparisons with decoded exports: all exposed color controls, effects, four look presets at two strengths, visible layered transforms/fades/text, and speed-adjusted motion. Cache reuse/invalidation, frame-grid sampling, output sizing, and history preservation passed. Mean absolute RGB errors ranged from 0.395 to 1.160 on a 0–255 scale; PSNR was at least 40.15 dB. Artifacts: `engine/build/mcp-composition-1788645525291/report.json`.
- Rebuilt engine core suite passed in 45.67 seconds after the shared compositor refactor and look-strength correction.
- Media recovery integration passed 62 calls: Unicode paths, missing/corrupt imports, moved files, incompatible replacements, locked tracks, relink undo/redo, copy rollback, source-independent copies, save/reopen, and export. Artifacts: `engine/build/mcp-media-recovery-1788647012313/report.json`.
- Split-fade integration passed 193 calls and 28 pixel/audio comparisons for mono/stereo sources at 100% and 200% speed. Repeated cuts inside fades preserved paused PNGs, saved state, and undo/redo. Sampled decoded video pixels matched exactly; audio RMS differences were below 1%. This exposed and fixed a channel-layout crash and invalid delayed-silence timestamps after source seeking. Artifacts: `engine/build/mcp-split-fades-1788648350178/report.json`.

The user's goal explicitly authorizes tests. Test projects and rendered artifacts are created under `engine/build/mcp-*`; user projects are not used as fixtures.

Native inspection works after explicitly activating the selected editor window. Edit, selected clip inspector, Color, empty Plugins, and title/subtitle dialogs were inspected at default and narrow widths. At the minimum 980×680 client size, the title action remained reachable through the new internal scrollbar. This review found and corrected status-badge overlap, hidden timeline controls, excessive toolbar wrapping, clipped media filters, and overflowing dialogs. The new Settings form was inspected at default size; a canvas edit created one undo step, its copy preference produced a byte-identical project copy through the native file picker, and reverting both edits restored the project. Preference-only changes created no undo entries, and the copy preference was restored to its original default after checking. Home confirmed that new temporary fixtures stay out of recents after saves/autosaves. Populated plugin screens, remaining dialogs, compact Settings/Color/Effects layout, and end-to-end editing still need the final visual audit.

## Next concrete checks

- Finish motion preview through the shared compositor, including audio timing and normalization parity; explicitly bound unsupported HDR behavior.
- Source validation, relinking, project copies, and split fades now have real-media regression coverage. Complete their native UI interaction review and the remaining basic-workflow audit. Verify the inspector submits the displayed crossfade duration, including values greater than half a clip.
- Complete native populated-plugin, export/settings/marker, and missing-media dialogs. Compact Color now retains a usable monitor and scrolls its controls at short heights; check Effects with populated stacks too.
- Temporary fixture projects now use `remember: false`; their exclusion from the native Home list is verified.
