import type { PreviewState } from "@ai-video-editor/protocol";
import { engineRpc } from "../commands/commandClient";

export type PreviewQuality = "Full" | "1/2" | "1/4" | "Proxy";

export const previewQualities: PreviewQuality[] = ["Full", "1/2", "1/4", "Proxy"];

export interface NativePreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
}

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

async function getInvoke(): Promise<TauriInvoke | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return null;
  }

  const api = await import("@tauri-apps/api/core");
  return api.invoke as TauriInvoke;
}

export function elementToNativePreviewRect(element: HTMLElement): NativePreviewRect {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    scaleFactor: window.devicePixelRatio || 1
  };
}

export async function attachNativePreviewSurface(rect: NativePreviewRect) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<PreviewState>("preview_attach", { rect });
  }

  return engineRpc<PreviewState>("preview.attach", { parentHwnd: "browser", rect });
}

export async function resizeNativePreviewSurface(rect: NativePreviewRect) {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<PreviewState>("preview_resize", { rect });
  }

  return engineRpc<PreviewState>("preview.resize", { rect });
}

export function setNativePreviewState(params: Record<string, unknown>) {
  return engineRpc<PreviewState>("preview.set_state", params);
}

export function playNativePreview() {
  return engineRpc<PreviewState>("preview.play");
}

export function pauseNativePreview() {
  return engineRpc<PreviewState>("preview.pause");
}

export function seekNativePreview(playheadUs: number) {
  return engineRpc<PreviewState>("preview.seek", { playheadUs });
}

export function getNativePreviewStats() {
  return engineRpc<PreviewState>("preview.stats");
}
