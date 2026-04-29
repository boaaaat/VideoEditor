# Feature Roadmap

This roadmap groups the next major work into milestones that should be implemented together. Each milestone should keep the app usable, log important actions, and include focused regression checks before moving on.

## 1. Observability and Stability

- Add the app-wide logs drawer, structured log entries, and project log file persistence.
- Log project, media, timeline, export, AI, plugin, and engine status events consistently.
- Make command and save failures easy to diagnose without blocking editor actions.

Acceptance: every visible editor action produces a useful log entry, and project logs append under `logs/`.

## 2. Project Save/Load Reliability

- Add explicit dirty state, autosave status, save failures, and recovery messaging.
- Improve recent projects and missing-media detection.
- Restore media, timeline, project settings, and AI proposal state predictably.

Acceptance: closing and reopening a project restores the expected editing state.

## 3. Command History and Undo/Redo

- Complete command history integration for media and timeline commands.
- Add undo/redo UI state and restore points for AI-generated edits.
- Ensure reversible actions store enough before/after data.

Acceptance: add, delete, split, ripple delete, nudge, and remove-media actions can undo and redo safely.

## 4. Media Management

- Add thumbnails, waveforms, proxy/cache status, and relink missing media.
- Add bin rename, sort, search, and filters by type, duration, resolution, and fps.
- Keep metadata accurate for imported files.

Acceptance: large media bins stay usable and imported metadata matches the source files.

## 5. Timeline Editing Core

- Finish selection, snapping, trimming, and clip edge dragging behavior.
- Add multi-select, duplicate, cut/copy/paste, and track lock/mute/solo polish.
- Keep locked-track behavior non-mutating and clearly logged.

Acceptance: common clip edits can be done without manual timeline data fixes.

## 6. Playback and Preview

- Improve playhead sync, preview scaling, frame stepping, and loop playback.
- Keep wheel panning and Shift/Ctrl wheel zoom behavior consistent.
- Make preview stats and warnings actionable.

Acceptance: preview and timeline remain synchronized during normal editing.

## 7. Export Pipeline

- Replace simulated export with a real render path.
- Add presets, destination validation, overwrite handling, progress logs, and cancel support.
- Validate output duration, resolution, fps, audio, and color settings.

Acceptance: exported files match the timeline and selected export settings.

## 8. Audio Tools

- Wire audio tab controls to real clip or project audio processing.
- Add waveform display, gain, fades, mute, normalization, and basic cleanup tools.
- Carry audio changes into preview and export.

Acceptance: audio edits can be heard in preview and exported output.

## 9. Color and Effects

- Wire color controls and LUT selection to clip state.
- Add a basic per-clip effects stack with enable, disable, and reset.
- Carry visual changes into preview and export.

Acceptance: color and effect changes are visible in preview and exported output.

## 10. AI Workflows

- Convert placeholder AI proposals into real, reviewable timeline commands.
- Add transcript-aware rough cuts, clip suggestions, and safe restore points.
- Keep all AI actions inspectable, reversible, and logged.

Acceptance: AI-generated edits can be reviewed, applied, rejected, and undone.

## 11. Plugin System

- Move plugin UI from placeholder to real discovery, install, run, and status flows.
- Surface plugin logs in the main Logs drawer with plugin source labels.
- Isolate plugin failures from project corruption.

Acceptance: plugins can run without hiding errors or mutating projects silently.

## 12. Quality of Life and Polish

- Add a shortcuts editor, command palette actions, better empty/loading states, and clearer disabled states.
- Run performance passes for large timelines and media bins.
- Improve accessibility for menus, drawers, focus, and keyboard navigation.

Acceptance: repeated editing workflows are faster, clearer, and easier to diagnose.
