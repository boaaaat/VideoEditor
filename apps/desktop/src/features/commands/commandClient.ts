import type { AiEditProposal, CommandResult, EditorCommand, EngineStatus, ExportStatus, MediaMetadata, PreviewState, Timeline } from "@ai-video-editor/protocol";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface CommandExecutionEventDetail {
  phase: "start" | "finish" | "error";
  commandType: EditorCommand["type"];
  command: EditorCommand;
  commandId?: string;
  ok?: boolean;
  error?: string;
  durationMs?: number;
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
  droppedFrames: 0,
  previewFps: 0,
  quality: "Proxy",
  colorMode: "SDR",
  hdrOutputAvailable: false
};

const browserTimeline: Timeline = {
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
      return { ok: true, commandId: `browser-${Date.now()}` } as T;
    }

    if (method === "media.index") {
      return { media: [] } as T;
    }

    if (method === "timeline.state") {
      return browserTimeline as T;
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

function emitCommandExecutionEvent(detail: CommandExecutionEventDetail) {
  window.dispatchEvent(new CustomEvent("ai-video-editor:command-execution", { detail }));
}
