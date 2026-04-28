import type { CommandResult, EditorCommand, EngineStatus, ExportStatus, MediaMetadata, PreviewState } from "@ai-video-editor/protocol";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

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
      browserExportStatus = {
        ...browserExportStatus,
        jobId: `browser-export-${Date.now()}`,
        state: "running",
        progress: 0.1,
        logs: ["Browser preview accepted export settings."]
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

export function executeCommand(command: EditorCommand): Promise<CommandResult> {
  return engineRpc<CommandResult>("command.execute", command);
}
