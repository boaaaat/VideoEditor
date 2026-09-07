import type { ProjectSettings, Timeline } from "@ai-video-editor/protocol";
import type { MediaAsset } from "../media/mediaTypes";

export interface CompositionFrame { dataUrl: string; timeUs: number; width: number; height: number; cached: boolean; description: string }
export interface CompositionFrameInput { timeline: Timeline; mediaAssets: MediaAsset[]; projectSettings: ProjectSettings; projectPath?: string; timeUs: number; maxWidth?: number }
export type CompositionPlaybackInput = Omit<CompositionFrameInput, "timeUs">;
export interface CompositionPlaybackJob {
  jobId: string; state: "queued" | "rendering" | "completed" | "cancelled" | "failed";
  progress: number; durationUs?: number; width?: number; height?: number; path?: string; cached?: boolean; error?: string;
}
export function compositionPlaybackParams(input: CompositionPlaybackInput) {
  return {width:input.projectSettings.width,height:input.projectSettings.height,fps:input.projectSettings.fps,
    colorMode:input.projectSettings.colorMode,audioEnabled:input.projectSettings.audioEnabled,
    masterGainDb:input.projectSettings.masterGainDb,normalizeAudio:input.projectSettings.normalizeAudio,cleanupAudio:input.projectSettings.cleanupAudio,
    projectPath:input.projectPath,timeline:input.timeline,mediaAssets:input.mediaAssets,maxWidth:input.maxWidth ?? 1280};
}

export async function renderCompositionPlayback(input: CompositionPlaybackInput, signal: AbortSignal, onProgress: (job: CompositionPlaybackJob) => void) {
  const { invoke } = await import("@tauri-apps/api/core");
  if (signal.aborted) throw new Error("Playback render cancelled");
  const job = await invoke<CompositionPlaybackJob>("composition_playback_start", {params:compositionPlaybackParams(input)});
  const cancel = () => { void invoke("composition_playback_cancel", {jobId:job.jobId}).catch(() => undefined); };
  signal.addEventListener("abort", cancel, {once:true});
  try {
    if (signal.aborted) { cancel(); throw new Error("Playback render cancelled"); }
    let current = job;
    while (!signal.aborted) {
      onProgress(current);
      if (current.state === "completed") return current;
      if (current.state === "failed" || current.state === "cancelled") throw new Error(current.error ?? "Playback render cancelled");
      await new Promise<void>((resolve) => { const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = window.setTimeout(done, 400); signal.addEventListener("abort", done, {once:true}); });
      if (!signal.aborted) current = await invoke<CompositionPlaybackJob>("composition_playback_status", {jobId:job.jobId});
    }
    throw new Error("Playback render cancelled");
  } finally { signal.removeEventListener("abort", cancel); }
}

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
