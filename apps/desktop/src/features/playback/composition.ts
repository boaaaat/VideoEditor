import type { ProjectSettings, Timeline } from "@ai-video-editor/protocol";
import type { MediaAsset } from "../media/mediaTypes";

export interface CompositionFrame { dataUrl: string; timeUs: number; width: number; height: number; cached: boolean; description: string }
export interface CompositionFrameInput { timeline: Timeline; mediaAssets: MediaAsset[]; projectSettings: ProjectSettings; projectPath?: string; timeUs: number; maxWidth?: number }

export async function getCompositionFrame(input: CompositionFrameInput, signal?: AbortSignal): Promise<CompositionFrame> {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("Rendered composition previews require the desktop app");
  if (signal?.aborted) throw new Error("Frame request cancelled");
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = crypto.randomUUID();
  const cancel = () => { void invoke("composition_cancel", {requestId}).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, {once:true});
  try {
    const result = await invoke<CompositionFrame>("composition_frame", {requestId, params:{
      width:input.projectSettings.width, height:input.projectSettings.height, fps:input.projectSettings.fps,
      colorMode:input.projectSettings.colorMode, projectPath:input.projectPath,
      timeline:input.timeline, mediaAssets:input.mediaAssets, timeUs:Math.round(input.timeUs), maxWidth:input.maxWidth ?? 1280
    }});
    if (signal?.aborted) throw new Error("Frame request cancelled");
    return result;
  } finally { signal?.removeEventListener("abort", cancel); }
}
