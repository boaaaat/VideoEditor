import type { CommandResult, EditorCommand, EngineStatus } from "@ai-video-editor/protocol";

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
    message: "Running in browser preview. Launch Tauri to detect NVIDIA hardware."
  }
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
