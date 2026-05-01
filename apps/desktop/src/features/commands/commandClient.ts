import type { AiEditProposal, CommandResult, EditorCommand, EngineStatus, ExportStatus, MediaMetadata, PreviewState, Timeline } from "@ai-video-editor/protocol";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

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
let browserUndoCount = 0;
let browserRedoCount = 0;

async function getInvoke(): Promise<TauriInvoke | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return null;
  }

  const api = await import("@tauri-apps/api/core");
  return api.invoke as TauriInvoke;
}

export async function engineRpc<T>(method: string, params?: unknown): Promise<T> {
  const invoke = await getInvoke();

  if (!invoke) {
    if (method === "engine.status") {
      return browserEngineStatus as T;
    }

    if (method === "command.execute") {
      const command = params as EditorCommand;
      browserTimeline = applyBrowserTimelineCommand(browserTimeline, command);
      browserUndoCount += 1;
      browserRedoCount = 0;
      return { ok: true, commandId: `browser-${Date.now()}`, commandType: command.type, data: { timeline: browserTimeline }, undoCount: browserUndoCount, redoCount: browserRedoCount } as T;
    }

    if (method === "command.undo") {
      if (browserUndoCount > 0) {
        browserUndoCount -= 1;
        browserRedoCount += 1;
      }
      return { ok: browserRedoCount > 0, data: browserProjectState, undoCount: browserUndoCount, redoCount: browserRedoCount } as T;
    }

    if (method === "command.redo") {
      if (browserRedoCount > 0) {
        browserRedoCount -= 1;
        browserUndoCount += 1;
      }
      return { ok: browserUndoCount > 0, data: browserProjectState, undoCount: browserUndoCount, redoCount: browserRedoCount } as T;
    }

    if (method === "command.history") {
      return { undoCount: browserUndoCount, redoCount: browserRedoCount, canUndo: browserUndoCount > 0, canRedo: browserRedoCount > 0 } as T;
    }

    if (method === "media.index") {
      return { media: [] } as T;
    }

    if (method === "timeline.state") {
      return browserTimeline as T;
    }

    if (method === "project.reset") {
      browserProjectState = params;
      browserUndoCount = 0;
      browserRedoCount = 0;
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
          bitrateMbps: 16,
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
        hasAudio: true
      } as MediaMetadata as T;
    }

    if (method.startsWith("preview.")) {
      return browserPreviewState as T;
    }

    if (method === "export.start") {
      const request = params as Partial<ExportStatus> & { durationUs?: number } | undefined;
      browserExportStatus = {
        ...browserExportStatus,
        jobId: `browser-export-${Date.now()}`,
        outputPath: request?.outputPath,
        state: "running",
        progress: 0.1,
        width: request?.width,
        height: request?.height,
        fps: request?.fps,
        durationUs: request?.durationUs,
        codec: request?.codec,
        container: request?.container,
        quality: request?.quality,
        bitrateMbps: request?.bitrateMbps,
        audioEnabled: request?.audioEnabled,
        colorMode: request?.colorMode,
        logs: ["Browser preview accepted export settings; file rendering is available in the desktop app."]
      };
      return browserExportStatus as T;
    }

    if (method === "export.cancel") {
      browserExportStatus = {
        ...browserExportStatus,
        state: "cancelled",
        logs: ["Browser preview export cancelled."]
      };
      return browserExportStatus as T;
    }

    if (method === "export.status") {
      if (browserExportStatus.state === "running") {
        const nextProgress = Math.min(1, browserExportStatus.progress + 0.12);
        browserExportStatus = {
          ...browserExportStatus,
          state: nextProgress >= 1 ? "completed" : "running",
          progress: nextProgress,
          logs: [...browserExportStatus.logs, nextProgress >= 1 ? "Export completed." : `Progress ${Math.round(nextProgress * 100)}%`]
        };
      }
      return browserExportStatus as T;
    }

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

function applyBrowserTimelineCommand(timeline: Timeline, command: EditorCommand): Timeline {
  switch (command.type) {
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
    case "add_clip":
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
          color: { brightness: 0, contrast: 0, saturation: 1, temperature: 0, tint: 0 },
          audio: { gainDb: 0, muted: false, fadeInUs: 0, fadeOutUs: 0, normalize: false, cleanup: false },
          transform: { enabled: true, scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1 },
          effects: []
        }
      ]);
    case "move_clip": {
      const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId);
      if (!clip) {
        return timeline;
      }
      const withoutClip = {
        ...timeline,
        tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((item) => item.id !== command.clipId) }))
      };
      return updateBrowserTrackClips(withoutClip, command.trackId, (clips) => [...clips, { ...clip, trackId: command.trackId, startUs: command.startUs }]);
    }
    case "trim_clip":
      return updateBrowserClip(timeline, command.clipId, (clip) =>
        command.edge === "start"
          ? { ...clip, inUs: Math.max(0, clip.inUs + Math.max(0, command.timeUs - clip.startUs)), startUs: Math.max(0, command.timeUs) }
          : { ...clip, outUs: Math.max(clip.inUs + 250_000, command.timeUs) }
      );
    case "split_clip": {
      const clip = command.clipId
        ? timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === command.clipId)
        : timeline.tracks.flatMap((track) => track.clips).find((item) => command.playheadUs > item.startUs && command.playheadUs < item.startUs + getBrowserClipDisplayDurationUs(item));
      if (!clip || command.playheadUs <= clip.startUs || command.playheadUs >= clip.startUs + getBrowserClipDisplayDurationUs(clip)) {
        return timeline;
      }
      const splitInUs = clip.inUs + Math.round((command.playheadUs - clip.startUs) * (normalizeBrowserSpeed(clip.speedPercent) / 100));
      const secondClip = { ...clip, id: `clip_${Date.now()}`, startUs: command.playheadUs, inUs: splitInUs };
      return updateBrowserTrackClips(timeline, clip.trackId, (clips) => clips.flatMap((item) => (item.id === clip.id ? [{ ...item, outUs: splitInUs }, secondClip] : [item])));
    }
    case "delete_clip":
      return { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== command.clipId) })) };
    case "ripple_delete_clip": {
      const deletedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === command.clipId);
      if (!deletedClip) {
        return timeline;
      }
      const deletedDurationUs = getBrowserClipDisplayDurationUs(deletedClip);
      return updateBrowserTrackClips(timeline, deletedClip.trackId, (clips) =>
        clips
          .filter((clip) => clip.id !== deletedClip.id)
          .map((clip) => (clip.startUs > deletedClip.startUs ? { ...clip, startUs: Math.max(0, clip.startUs - deletedDurationUs) } : clip))
      );
    }
    case "apply_color_adjustment":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, color: { ...clip.color, ...command.adjustment } }));
    case "apply_lut":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, lut: command.lutId ? { lutId: command.lutId, strength: command.strength } : undefined }));
    case "apply_audio_adjustment":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, audio: { gainDb: 0, muted: false, fadeInUs: 0, fadeOutUs: 0, normalize: false, cleanup: false, ...clip.audio, ...command.adjustment } }));
    case "apply_clip_speed":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, speedPercent: normalizeBrowserSpeed(command.speedPercent) }));
    case "apply_transform":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, transform: { enabled: true, scale: 1, positionX: 0, positionY: 0, rotation: 0, opacity: 1, ...clip.transform, ...command.transform } }));
    case "apply_effect_stack":
      return updateBrowserClip(timeline, command.clipId, (clip) => ({ ...clip, effects: command.effects }));
    default:
      return timeline;
  }
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
