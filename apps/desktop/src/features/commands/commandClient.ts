import type { AiEditProposal, CommandResult, EditorCommand, EngineStatus, ExportStatus, MediaMetadata, PreviewState, Timeline, TitleOverlay } from "@ai-video-editor/protocol";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function validateBrowserTitle(title: TitleOverlay) {
  if (!title.text.trim() || title.text.includes("\0") || new TextEncoder().encode(title.text).length > 4000 || !Number.isSafeInteger(title.startUs) || !Number.isSafeInteger(title.durationUs) || !Number.isSafeInteger(title.startUs + title.durationUs) || title.startUs < 0 || title.durationUs <= 0 || !Number.isInteger(title.fontSize) || title.fontSize < 10 || title.fontSize > 300 || ![title.positionX,title.positionY].every((value) => Number.isFinite(value) && value >= 0 && value <= 100) || !/^#[0-9a-f]{6}$/i.test(title.color) || !["title", "caption"].includes(title.kind ?? "title")) throw new Error("Invalid title text, timing, or style");
}

export interface CommandExecutionEventDetail {
  phase: "start" | "finish" | "undo" | "redo" | "error";
  commandType?: EditorCommand["type"];
  command?: EditorCommand;
  commandId?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  undoCount?: number;
  redoCount?: number;
}

export interface CommandHistoryStatus {
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

const browserEngineStatus: EngineStatus = {
  appName: "AI Video Editor",
  version: "0.1.0",
  previewUrl: "http://127.0.0.1:47110/preview",
  ffmpeg: {
    available: false,
    message: "Running in browser preview. Launch Tauri to detect FFmpeg."
  },
  ffprobe: {
    available: false,
    message: "Running in browser preview. Launch Tauri to detect FFprobe."
  },
  gpu: {
    available: false,
    nvencAvailable: false,
    h264NvencAvailable: false,
    hevcNvencAvailable: false,
    av1NvencAvailable: false,
    message: "Running in browser preview. Launch Tauri to detect NVIDIA hardware."
  }
};

let browserExportStatus: ExportStatus = {
  jobId: null,
  state: "idle",
  progress: 0,
  logs: []
};

const browserPreviewState: PreviewState = {
  attached: false,
  state: "paused",
  codec: "unknown",
  decodeMode: "idle",
  renderMode: "fallback",
  droppedFrames: 0,
  previewFps: 0,
  quality: "Proxy",
  colorMode: "SDR",
  hdrOutputAvailable: false
};

let browserTimeline: Timeline = {
  id: "timeline_main",
  name: "Main Timeline",
  fps: 30,
  durationUs: 10_000_000,
  tracks: [
    { id: "v2", name: "Video 2", kind: "video", index: 0, locked: false, muted: false, visible: true, clips: [] },
    { id: "v1", name: "Video 1", kind: "video", index: 1, locked: false, muted: false, visible: true, clips: [] },
    { id: "a1", name: "Audio 1", kind: "audio", index: 2, locked: false, muted: false, visible: true, clips: [] }
  ]
};

let browserProposals: AiEditProposal[] = [];
let browserProjectState: unknown = null;
const maxBrowserHistoryEntries = 200;

interface BrowserHistoryEntry {
  id: string;
  type: EditorCommand["type"];
  group: string;
  beforeState: unknown;
  afterState: unknown;
}

let browserUndoStack: BrowserHistoryEntry[] = [];
let browserRedoStack: BrowserHistoryEntry[] = [];

async function getInvoke(): Promise<TauriInvoke | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return null;
  }

  const api = await import("@tauri-apps/api/core");
  return api.invoke as TauriInvoke;
}

let pendingEditorRequests = 0;
export function isEngineEditing() { return pendingEditorRequests > 0; }

export async function engineRpc<T>(method: string, params?: unknown): Promise<T> {
  const editing = /^(command\.(execute|undo|redo)|project\.(open|create|reset|save_state)|ai\.proposal\.)/.test(method);
  if (editing) pendingEditorRequests++;
  try { return await rawEngineRpc<T>(method, params); }
  finally { if (editing) pendingEditorRequests--; }
}

async function rawEngineRpc<T>(method: string, params?: unknown): Promise<T> {
  const invoke = await getInvoke();

  if (!invoke) {
    if (method === "engine.status") {
      return browserEngineStatus as T;
    }

    if (method === "command.execute") {
      const command = params as EditorCommand;
      const beforeState = browserProjectSnapshot();
      if (command.type === "update_project_settings") {
        const state = (browserProjectState ?? {}) as Record<string, unknown>;
        const settings = { ...state.projectSettings as object, ...command.settings };
        browserProjectState = { ...state, projectSettings: settings };
        if (settings.fps) browserTimeline = { ...browserTimeline, fps: settings.fps };
      }
      const nextTimeline = applyBrowserTimelineCommand(browserTimeline, command);
      browserTimeline = nextTimeline;
      const afterState = browserProjectSnapshot();
      const commandId = `browser-${command.type}-${Date.now()}`;
      recordBrowserCommand(command, commandId, beforeState, afterState);
      return { ok: true, commandId, commandType: command.type, data: command.type === "update_project_settings" ? browserProjectSnapshot() : { timeline: browserTimeline }, undoCount: browserUndoStack.length, redoCount: browserRedoStack.length } as T;
    }

    if (method === "command.undo") {
      if (browserUndoStack.length === 0) {
        return { ok: false, error: "Nothing to undo", data: browserProjectSnapshot(), undoCount: browserUndoStack.length, redoCount: browserRedoStack.length } as T;
      }
      const entry = browserUndoStack.pop()!;
      browserRedoStack.push(entry);
      applyBrowserProjectSnapshot(entry.beforeState);
      return { ok: true, commandId: entry.id, commandType: entry.type, data: browserProjectSnapshot(), undoCount: browserUndoStack.length, redoCount: browserRedoStack.length } as T;
    }

    if (method === "command.redo") {
      if (browserRedoStack.length === 0) {
        return { ok: false, error: "Nothing to redo", data: browserProjectSnapshot(), undoCount: browserUndoStack.length, redoCount: browserRedoStack.length } as T;
      }
      const entry = browserRedoStack.pop()!;
      browserUndoStack.push(entry);
      applyBrowserProjectSnapshot(entry.afterState);
      return { ok: true, commandId: entry.id, commandType: entry.type, data: browserProjectSnapshot(), undoCount: browserUndoStack.length, redoCount: browserRedoStack.length } as T;
    }

    if (method === "command.history") {
      return { undoCount: browserUndoStack.length, redoCount: browserRedoStack.length, canUndo: browserUndoStack.length > 0, canRedo: browserRedoStack.length > 0 } as T;
    }

    if (method === "media.index") {
      return { media: [] } as T;
    }

    if (method === "timeline.state") {
      return browserTimeline as T;
    }

    if (method === "project.reset") {
      browserProjectState = params;
      applyBrowserProjectSnapshot(params);
      browserUndoStack = [];
      browserRedoStack = [];
      return {} as T;
    }

    if (method === "project.open") {
      return (browserProjectState ?? {
        version: 1,
        savedAt: new Date().toISOString(),
        project: params ?? {},
        projectSettings: {
          resolution: "1080p",
          width: 1920,
          height: 1080,
          fps: 30,
          colorMode: "SDR",
          bitrateMbps: 9,
          defaultCodec: "h264_nvenc",
          defaultContainer: "mp4",
          audioEnabled: true,
          masterGainDb: 0,
          normalizeAudio: false,
          cleanupAudio: false
        },
        mediaAssets: [],
        timeline: browserTimeline,
        aiProposals: browserProposals
      }) as T;
    }

    if (method === "project.save_state") {
      browserProjectState = params;
      applyBrowserProjectSnapshot(params);
      return params as T;
    }

    if (method === "ai.proposals") {
      return { proposals: browserProposals } as T;
    }

    if (method === "ai.proposal.generate") {
      const proposal: AiEditProposal = {
        id: `browser-proposal-${Date.now()}`,
        goal: (params as { goal?: string } | undefined)?.goal ?? "make a rough cut",
        status: "pending",
        explanation: "Browser preview created a placeholder proposal. Launch Tauri for engine-backed proposals.",
        commands: [],
        createdAt: new Date().toISOString()
      };
      browserProposals = [proposal, ...browserProposals];
      return proposal as T;
    }

    if (method === "ai.proposal.apply" || method === "ai.proposal.reject") {
      const proposalId = (params as { proposalId?: string } | undefined)?.proposalId ?? "";
      const status = method === "ai.proposal.apply" ? "applied" : "rejected";
      browserProposals = browserProposals.map((proposal) => (proposal.id === proposalId ? { ...proposal, status } : proposal));
      return (browserProposals.find((proposal) => proposal.id === proposalId) ?? null) as T;
    }

    if (method === "media.probe") {
      const path = (params as { path?: string } | undefined)?.path ?? "browser-preview.mp4";
      return {
        path,
        width: 1920,
        height: 1080,
        fps: 30,
        durationUs: 8_000_000,
        codec: "h264",
        pixelFormat: "yuv420p",
        colorTransfer: "bt709",
        hdr: false,
        hasAudio: true,
        audioStreamCount: 1,
        audioStreams: [{ index: 0, codec: "aac", channels: 2, title: "Audio 1" }]
      } as MediaMetadata as T;
    }

    if (method.startsWith("preview.")) {
      return browserPreviewState as T;
    }

    if (method === "export.start") {
      browserExportStatus = { jobId: null, state: "error", progress: 0, logs: ["File rendering requires the desktop app."] };
      return browserExportStatus as T;
    }
    if (method === "export.status" || method === "export.cancel") return browserExportStatus as T;

    return {} as T;
  }

  return invoke<T>("engine_rpc", { method, params });
}

export function getEngineStatus(): Promise<EngineStatus> {
  return engineRpc<EngineStatus>("engine.status");
}

export async function executeCommand(command: EditorCommand): Promise<CommandResult> {
  const startedAt = performance.now();
  emitCommandExecutionEvent({
    phase: "start",
    commandType: command.type,
    command
  });

  try {
    const result = await engineRpc<CommandResult>("command.execute", command);
    emitCommandExecutionEvent({
      phase: "finish",
      commandType: command.type,
      command,
      commandId: result.commandId,
      ok: result.ok,
      error: result.error,
      undoCount: result.undoCount,
      redoCount: result.redoCount,
      durationMs: Math.round(performance.now() - startedAt)
    });
    return result;
  } catch (error) {
    emitCommandExecutionEvent({
      phase: "error",
      commandType: command.type,
      command,
      error: error instanceof Error ? error.message : "Command execution failed",
      durationMs: Math.round(performance.now() - startedAt)
    });
    throw error;
  }
}

export async function undoCommand(): Promise<CommandResult> {
  const result = await engineRpc<CommandResult>("command.undo");
  emitCommandExecutionEvent({
    phase: "undo",
    commandType: result.commandType,
    commandId: result.commandId,
    ok: result.ok,
    error: result.error,
    undoCount: result.undoCount,
    redoCount: result.redoCount
  });
  return result;
}

export async function redoCommand(): Promise<CommandResult> {
  const result = await engineRpc<CommandResult>("command.redo");
  emitCommandExecutionEvent({
    phase: "redo",
    commandType: result.commandType,
    commandId: result.commandId,
    ok: result.ok,
    error: result.error,
    undoCount: result.undoCount,
    redoCount: result.redoCount
  });
  return result;
}

export function getCommandHistory(): Promise<CommandHistoryStatus> {
  return engineRpc<CommandHistoryStatus>("command.history");
}

function emitCommandExecutionEvent(detail: CommandExecutionEventDetail) {
  window.dispatchEvent(new CustomEvent("ai-video-editor:command-execution", { detail }));
}

function browserProjectSnapshot() {
  const base = cloneJson(browserProjectState) as Record<string, unknown> | null;
  return {
    ...(base ?? {}),
    timeline: browserTimeline,
    aiProposals: browserProposals
  };
}

function applyBrowserProjectSnapshot(snapshot: unknown) {
  browserProjectState = cloneJson(snapshot);
  const state = browserProjectState as { timeline?: Timeline; aiProposals?: AiEditProposal[] } | null;
  if (state?.timeline?.tracks) {
    browserTimeline = state.timeline;
  }
  if (Array.isArray(state?.aiProposals)) {
    browserProposals = state.aiProposals;
  }
}

function recordBrowserCommand(command: EditorCommand, commandId: string, beforeState: unknown, afterState: unknown) {
  if (JSON.stringify(beforeState) === JSON.stringify(afterState)) {
    return;
  }

  const historyMode = command.history?.mode ?? "push";
  if (historyMode === "none") {
    browserRedoStack = [];
    return;
  }

  const entry: BrowserHistoryEntry = {
    id: commandId,
    type: command.type,
    group: command.history?.group ?? "",
    beforeState: cloneJson(beforeState),
    afterState: cloneJson(afterState)
  };

  if (historyMode === "replace" && entry.group && browserUndoStack.at(-1)?.group === entry.group) {
    entry.beforeState = browserUndoStack.at(-1)!.beforeState;
    browserUndoStack[browserUndoStack.length - 1] = entry;
  } else {
    browserUndoStack.push(entry);
    if (browserUndoStack.length > maxBrowserHistoryEntries) {
      browserUndoStack = browserUndoStack.slice(-maxBrowserHistoryEntries);
    }
  }
  browserRedoStack = [];
}

function cloneJson<T>(value: T): T {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function applyBrowserTimelineCommand(timeline: Timeline, command: EditorCommand): Timeline {
  if (command.type === "execute_batch") {
    if (!command.commands.length || command.commands.length > 500) throw new Error("A batch needs 1 to 500 editing commands");
    return command.commands.reduce((current, item) => {
      if (["execute_batch", "import_media", "relink_media", "remove_media", "export_timeline", "update_project_settings"].includes(item.type)) throw new Error("A batch only supports timeline editing commands");
      return applyBrowserTimelineCommand(current, item);
    }, timeline);
  }
  if ("clipId" in command && command.clipId && command.type !== "add_clip") {
    const track = timeline.tracks.find((item) => item.clips.some((clip) => clip.id === command.clipId));
    if (!track) throw new Error("Clip not found");
    if (track.locked) throw new Error(`${track.name} is locked`);
  }
  if (["add_clip", "move_clip", "delete_track"].includes(command.type) && "trackId" in command) {
    const track = timeline.tracks.find((item) => item.id === command.trackId);
    if (!track) throw new Error("Track not found");
    if (track.locked) throw new Error(`${track.name} is locked`);
  }
  if ("startUs" in command && command.startUs !== undefined && command.startUs < 0) throw new Error("Start cannot be negative");
  if (command.type === "add_track" && command.trackId && timeline.tracks.some((track) => track.id === command.trackId)) throw new Error("Track ID already exists");
  switch (command.type) {
    case "set_clip_source_range": {
      const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId)!;
      const media = (browserProjectState as { mediaAssets?: { id: string; metadata?: { durationUs?: number; isStillImage?: boolean } }[] } | null)?.mediaAssets?.find((item) => item.id === clip.mediaId);
      if (command.inUs < 0 || command.outUs <= command.inUs || (!media?.metadata?.isStillImage && media?.metadata?.durationUs && command.outUs > media.metadata.durationUs)) throw new Error("Source range is outside media bounds");
      return updateBrowserClip(timeline, clip.id, (current) => ({ ...(current.inUs !== command.inUs || current.outUs !== command.outUs ? resetBrowserFadeRanges(current) : current), inUs: command.inUs, outUs: command.outUs }));
    }
    case "crossfade_clips": {
      const track = timeline.tracks.find((item) => item.clips.some((clip) => clip.id === command.firstClipId));
      const first = track?.clips.find((clip) => clip.id === command.firstClipId);
      const second = track?.clips.find((clip) => clip.id === command.secondClipId);
      if (!track || track.kind !== "video" || track.locked || !first || !second || first.id === second.id || Math.abs(first.startUs + getBrowserClipDisplayDurationUs(first) - second.startUs) > 1 || command.durationUs <= 0 || command.durationUs >= Math.min(getBrowserClipDisplayDurationUs(first), getBrowserClipDisplayDurationUs(second))) throw new Error("Crossfade needs adjacent clips on an unlocked video track and a duration shorter than both clips");
      let next = updateBrowserTrackClips(timeline, track.id, (clips) => clips.map((clip) => clip.id === first.id || clip.id === second.id ? resetBrowserFadeRanges(clip) : clip));
      next = applyBrowserTimelineCommand(next, { type: "apply_transform", clipId: first.id, transform: { fadeOutUs: 0 } });
      next = applyBrowserTimelineCommand(next, { type: "apply_audio_adjustment", clipId: first.id, adjustment: { fadeOutUs: command.durationUs } });
      next = applyBrowserTimelineCommand(next, { type: "apply_transform", clipId: second.id, transform: { enabled: true, fadeInUs: command.durationUs } });
      next = applyBrowserTimelineCommand(next, { type: "apply_audio_adjustment", clipId: second.id, adjustment: { fadeInUs: command.durationUs } });
      return updateBrowserTrackClips(next, track.id, (clips) => clips.map((clip) => clip.startUs >= second.startUs ? { ...clip, startUs: clip.startUs - command.durationUs } : clip));
    }
    case "import_captions": {
      if (!command.captions.length || command.captions.length > 5000 || !["append", "replace"].includes(command.mode ?? "append")) throw new Error("Import 1–5,000 captions with append or replace mode");
      const captions: TitleOverlay[] = command.captions.map((cue) => ({ fontSize: 36, color: "#ffffff", positionX: 50, positionY: 92, background: true, ...command.style, ...cue, id: crypto.randomUUID(), kind: "caption" }));
      for (const caption of captions) validateBrowserTitle(caption);
      return { ...timeline, titles: [...(timeline.titles ?? []).filter((title) => command.mode !== "replace" || title.kind !== "caption"), ...captions].sort((a, b) => a.startUs - b.startUs) };
    }
    case "add_title":
    case "update_title":
    case "delete_title": {
      const titles = timeline.titles ?? [];
      const titleId = command.titleId ?? crypto.randomUUID();
      const existing = titles.find((title) => title.id === titleId);
      if (command.type === "add_title" && existing) throw new Error("Title ID already exists");
      if (command.type !== "add_title" && !existing) throw new Error("Title not found");
      const remaining = titles.filter((title) => title.id !== titleId);
      if (command.type === "delete_title") return { ...timeline, titles: remaining };
      const { type: _type, titleId: _id, history: _history, ...values } = command;
      const next = { id: titleId, text: "Title", startUs: 0, durationUs: 3_000_000, fontSize: 48, color: "#ffffff", positionX: 50, positionY: 80, background: true, ...existing, ...values };
      validateBrowserTitle(next);
      return { ...timeline, titles: [...remaining, next].sort((a, b) => a.startUs - b.startUs) };
    }
    case "add_marker":
    case "update_marker":
    case "delete_marker": {
      const markers = timeline.markers ?? [];
      const markerId = command.markerId ?? crypto.randomUUID();
      const existing = markers.find((marker) => marker.id === markerId);
      if (command.type === "add_marker" && existing) throw new Error("Marker ID already exists");
      if (command.type !== "add_marker" && !existing) throw new Error("Marker not found");
      const remaining = markers.filter((marker) => marker.id !== markerId);
      if (command.type === "delete_marker") return { ...timeline, markers: remaining };
      const next = { id: markerId, timeUs: command.timeUs ?? existing?.timeUs ?? 0, name: command.name ?? existing?.name ?? "Marker", color: command.color ?? existing?.color ?? "#f5c76b" };
      if (!Number.isSafeInteger(next.timeUs) || next.timeUs < 0 || !next.name || next.name.length > 200 || !/^#[0-9a-f]{6}$/i.test(next.color)) throw new Error("Invalid marker name, time, or color");
      return { ...timeline, markers: [...remaining, next].sort((a, b) => a.timeUs - b.timeUs) };
    }
    case "add_track": {
      const index = clampInteger(command.index ?? timeline.tracks.length, 0, timeline.tracks.length);
      const sameKindCount = timeline.tracks.filter((track) => track.kind === command.kind).length + 1;
      const nextTrack = {
        id: command.trackId ?? `${command.kind[0]}${Date.now()}`,
        name: command.name ?? `${command.kind === "video" ? "Video" : "Audio"} ${sameKindCount}`,
        kind: command.kind,
        index,
        locked: false,
        muted: false,
        visible: true,
        clips: []
      };
      const tracks = [...timeline.tracks];
      tracks.splice(index, 0, nextTrack);
      return { ...timeline, tracks: reindexTracks(tracks) };
    }
    case "update_track":
      return {
        ...timeline,
        tracks: timeline.tracks.map((track) =>
          track.id === command.trackId
            ? {
                ...track,
                name: command.name?.trim() || track.name,
                locked: command.locked ?? track.locked,
                muted: command.muted ?? track.muted,
                visible: command.visible ?? track.visible
              }
            : track
        )
      };
    case "delete_track":
      return { ...timeline, tracks: reindexTracks(timeline.tracks.filter((track) => track.id !== command.trackId)) };
    case "add_clip": {
      const targetTrack = timeline.tracks.find((track) => track.id === command.trackId);
      if (!targetTrack || targetTrack.locked) {
        return timeline;
      }
      return updateBrowserTrackClips(timeline, command.trackId, (clips) => [
        ...clips.filter((clip) => clip.id !== (command.clipId ?? "")),
        {
          id: command.clipId ?? `clip_${Date.now()}`,
          mediaId: command.mediaId,
          trackId: command.trackId,
          startUs: command.startUs,
          inUs: command.inUs ?? 0,
          outUs: command.outUs ?? Math.max((command.inUs ?? 0) + 1_000_000, 8_000_000),
          speedPercent: normalizeBrowserSpeed(command.speedPercent),
          color: command.color ?? { brightness: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 },
          audio: command.audio ?? { gainDb: 0, muted: false, fadeInUs: 0, fadeOutUs: 0, normalize: false, cleanup: false },
          transform: command.transform ?? { enabled: true, scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1 },
          effects: command.effects ?? [],
          lut: command.lut ?? undefined
        }
      ]);
    }
    case "move_clip": {
      const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId);
      if (!clip) {
        return timeline;
      }
      const sourceTrack = timeline.tracks.find((track) => track.id === clip.trackId);
      const targetTrack = timeline.tracks.find((track) => track.id === command.trackId);
      if (sourceTrack?.kind && targetTrack?.kind && sourceTrack.kind !== targetTrack.kind) {
        return timeline;
      }
      if (sourceTrack?.locked || targetTrack?.locked || !targetTrack) {
        return timeline;
      }
      if (clip.trackId === command.trackId && clip.startUs === command.startUs) {
        return timeline;
      }
      const withoutClip = {
        ...timeline,
        tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((item) => item.id !== command.clipId) }))
      };
      return updateBrowserTrackClips(withoutClip, command.trackId, (clips) => [...clips, { ...clip, trackId: command.trackId, startUs: command.startUs }]);
    }
    case "trim_clip": {
      const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId);
      const track = clip ? timeline.tracks.find((item) => item.id === clip.trackId) : undefined;
      if (!clip || track?.locked) {
        return timeline;
      }
      const sourceInUs = clip.inUs + Math.round((command.timeUs - clip.startUs) * normalizeBrowserSpeed(clip.speedPercent) / 100);
      const state = browserProjectState as { mediaAssets?: Array<{ id: string; metadata?: { durationUs?: number; isStillImage?: boolean } }> } | null;
      const metadata = state?.mediaAssets?.find((asset) => asset.id === clip.mediaId)?.metadata;
      const durationUs = metadata?.isStillImage ? undefined : metadata?.durationUs;
      if (command.timeUs < 0 || (command.edge === "start" ? sourceInUs < 0 || sourceInUs >= clip.outUs : command.timeUs <= clip.inUs || Boolean(durationUs && command.timeUs > durationUs))) {
        throw new Error("Trim is outside the source range");
      }
      return updateBrowserClip(timeline, command.clipId, (clip) =>
        command.edge === "start"
          ? {
              ...(sourceInUs !== clip.inUs ? resetBrowserFadeRanges(clip) : clip),
              inUs: Math.max(
                0,
                clip.inUs + Math.round((Math.max(0, command.timeUs) - clip.startUs) * (normalizeBrowserSpeed(clip.speedPercent) / 100))
              ),
              startUs: Math.max(0, command.timeUs)
            }
          : { ...(clip.outUs !== command.timeUs ? resetBrowserFadeRanges(clip) : clip), outUs: command.timeUs }
      );
    }
    case "split_clip": {
      const clip = command.clipId
        ? timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId)
        : timeline.tracks.flatMap((track) => track.clips).find((item) => command.playheadUs > item.startUs && command.playheadUs < item.startUs + getBrowserClipDisplayDurationUs(item));
      if (!clip || command.playheadUs <= clip.startUs || command.playheadUs >= clip.startUs + getBrowserClipDisplayDurationUs(clip)) {
        return timeline;
      }
      const splitInUs = clip.inUs + Math.round((command.playheadUs - clip.startUs) * (normalizeBrowserSpeed(clip.speedPercent) / 100));
      if (splitInUs <= clip.inUs || splitInUs >= clip.outUs) return timeline;
      const duration = getBrowserClipDisplayDurationUs(clip);
      const delta = command.playheadUs - clip.startUs;
      const retain = <T extends { fadeInUs?: number; fadeOutUs?: number; fadeOffsetUs?: number; fadeDurationUs?: number }>(value: T | undefined, offset: number): T | undefined => value && (value.fadeInUs || value.fadeOutUs || value.fadeDurationUs) ? { ...value, fadeDurationUs: value.fadeDurationUs || duration, fadeOffsetUs: (value.fadeOffsetUs ?? 0) + offset } : value;
      const firstClip = { ...clip, outUs: splitInUs, audio: retain(clip.audio, 0), transform: retain(clip.transform, 0) };
      const secondClip = { ...clip, id: crypto.randomUUID(), startUs: command.playheadUs, inUs: splitInUs, audio: retain(clip.audio, delta), transform: retain(clip.transform, delta) };
      return updateBrowserTrackClips(timeline, clip.trackId, (clips) => clips.flatMap((item) => (item.id === clip.id ? [firstClip, secondClip] : [item])));
    }
    case "delete_clip": {
      const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId);
      const track = clip ? timeline.tracks.find((item) => item.id === clip.trackId) : undefined;
      if (track?.locked) {
        return timeline;
      }
      return { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== command.clipId) })) };
    }
    case "ripple_delete_clip": {
      const deletedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === command.clipId);
      if (!deletedClip) {
        return timeline;
      }
      const track = timeline.tracks.find((item) => item.id === deletedClip.trackId);
      if (track?.locked) {
        return timeline;
      }
      const deletedDurationUs = getBrowserClipDisplayDurationUs(deletedClip);
      const deletedEndUs = deletedClip.startUs + deletedDurationUs;
      const affectedTracks = timeline.tracks.filter((item) => command.trackMode === "all_tracks" || item.id === deletedClip.trackId);
      if (affectedTracks.some((item) => item.locked && item.clips.some((clip) => clip.startUs >= deletedEndUs))) throw new Error("Ripple delete would move a locked track");
      return { ...timeline, tracks: timeline.tracks.map((item) => affectedTracks.includes(item) ? { ...item, clips: item.clips.filter((clip) => clip.id !== deletedClip.id).map((clip) => clip.startUs >= deletedEndUs ? { ...clip, startUs: clip.startUs - deletedDurationUs } : clip) } : item) };
    }
    case "apply_color_adjustment":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, color: { ...clip.color, ...command.adjustment } }));
    case "apply_lut":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, lut: command.lutId ? { lutId: command.lutId, strength: command.strength } : undefined }));
    case "apply_audio_adjustment":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, audio: { gainDb: 0, muted: false, fadeInUs: 0, fadeOutUs: 0, normalize: false, cleanup: false, ...clip.audio, ...command.adjustment, ...browserFadeRange(clip.audio, command.adjustment) } }));
    case "apply_clip_speed":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...(normalizeBrowserSpeed(command.speedPercent) !== normalizeBrowserSpeed(clip.speedPercent) ? resetBrowserFadeRanges(clip) : clip), speedPercent: normalizeBrowserSpeed(command.speedPercent) }));
    case "apply_transform":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, transform: { enabled: true, scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, ...clip.transform, ...command.transform, ...browserFadeRange(clip.transform, command.transform) } }));
    case "apply_effect_stack":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, effects: command.effects }));
    default:
      return timeline;
  }
}

function resetBrowserFadeRanges(clip: Timeline["tracks"][number]["clips"][number]) {
  return { ...clip, audio: clip.audio ? { ...clip.audio, fadeOffsetUs: 0, fadeDurationUs: 0 } : undefined, transform: clip.transform ? { ...clip.transform, fadeOffsetUs: 0, fadeDurationUs: 0 } : undefined };
}

function browserFadeRange(before: {fadeInUs?: number; fadeOutUs?: number} | undefined, next: {fadeInUs?: number; fadeOutUs?: number}) {
  return (next.fadeInUs !== undefined && next.fadeInUs !== (before?.fadeInUs ?? 0)) || (next.fadeOutUs !== undefined && next.fadeOutUs !== (before?.fadeOutUs ?? 0)) ? {fadeOffsetUs: 0, fadeDurationUs: 0} : {};
}

function updateBrowserTrackClips(timeline: Timeline, trackId: string, updater: (clips: Timeline["tracks"][number]["clips"]) => Timeline["tracks"][number]["clips"]): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => (track.id === trackId ? { ...track, clips: updater(track.clips).sort((left, right) => left.startUs - right.startUs) } : track))
  };
}

function updateBrowserClip(timeline: Timeline, clipId: string, updater: (clip: Timeline["tracks"][number]["clips"][number]) => Timeline["tracks"][number]["clips"][number]): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => (clip.id === clipId ? updater(clip) : clip))
    }))
  };
}

function reindexTracks(tracks: Timeline["tracks"]) {
  return tracks.map((track, index) => ({ ...track, index }));
}

function getBrowserClipDisplayDurationUs(clip: Timeline["tracks"][number]["clips"][number]) {
  return Math.max(1, Math.round(Math.max(0, clip.outUs - clip.inUs) / (normalizeBrowserSpeed(clip.speedPercent) / 100)));
}

function normalizeBrowserSpeed(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(400, Math.max(25, Math.round(numeric))) : 100;
}

function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
