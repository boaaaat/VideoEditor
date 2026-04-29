import type { MediaIntelligence, MediaMetadata } from "@ai-video-editor/protocol";

export type MediaKind = "video" | "audio";
export type MediaCacheAvailability = "ready" | "ready-on-demand" | "missing" | "not-needed" | "unavailable" | "not-applicable" | "error";

export interface MediaCacheStatus {
  thumbnail: MediaCacheAvailability;
  waveform: MediaCacheAvailability;
  proxy: MediaCacheAvailability;
  proxyPath?: string;
}

export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  extension: string;
  importedAt: string;
  metadata?: MediaMetadata;
  intelligence?: MediaIntelligence;
}

export const supportedMediaExtensions = ["mp4", "mov", "mkv", "mp3"] as const;

export function isSupportedMediaPath(path: string) {
  const extension = getExtension(path);
  return supportedMediaExtensions.includes(extension as (typeof supportedMediaExtensions)[number]);
}

export function pathToMediaAsset(path: string, metadata?: MediaMetadata): MediaAsset {
  const name = getFileName(path);
  const extension = getExtension(path);

  return {
    id: `media_${stableHash(path)}_${Date.now()}`,
    name,
    path,
    extension,
    kind: extension === "mp3" ? "audio" : "video",
    importedAt: new Date().toISOString(),
    metadata
  };
}

export function getFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function getProjectNameFromPath(path: string) {
  const cleanPath = path.replace(/[\\/]project\.aivproj$/i, "");
  return getFileName(cleanPath) || "Untitled Project";
}

export async function getMediaSourceUrl(path: string) {
  if (!("__TAURI_INTERNALS__" in window)) {
    return path;
  }

  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc(path);
}

export async function getMediaThumbnailDataUrl(asset: MediaAsset) {
  if (asset.kind !== "video" || !("__TAURI_INTERNALS__" in window)) {
    return "";
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("media_thumbnail_data_url", { path: asset.path });
  } catch {
    return "";
  }
}

export async function getMediaPreviewFrameDataUrl(asset: MediaAsset, timeUs: number) {
  if (asset.kind !== "video" || !("__TAURI_INTERNALS__" in window)) {
    return "";
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("media_preview_frame_data_url", {
      path: asset.path,
      timeUs: Math.max(0, Math.round(timeUs))
    });
  } catch {
    return "";
  }
}

export async function getMediaWaveformDataUrl(asset: MediaAsset) {
  if (!mediaHasAudio(asset) || !("__TAURI_INTERNALS__" in window)) {
    return "";
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("media_waveform_data_url", { path: asset.path });
  } catch {
    return "";
  }
}

export async function getMediaCacheStatus(asset: MediaAsset, projectPath?: string): Promise<MediaCacheStatus> {
  const baseStatus: MediaCacheStatus = {
    thumbnail: asset.kind === "video" ? "ready-on-demand" : "not-applicable",
    waveform: mediaHasAudio(asset) ? "ready-on-demand" : "not-applicable",
    proxy: mediaNeedsProxy(asset) ? "missing" : "not-needed"
  };

  if (!projectPath || !("__TAURI_INTERNALS__" in window)) {
    return {
      ...baseStatus,
      proxy: baseStatus.proxy === "missing" ? "unavailable" : baseStatus.proxy
    };
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const proxy = await invoke<{ status: MediaCacheAvailability; path?: string }>("media_proxy_status", {
      path: asset.path,
      projectPath,
      needed: mediaNeedsProxy(asset)
    });
    return {
      ...baseStatus,
      proxy: proxy.status,
      proxyPath: proxy.path
    };
  } catch {
    return {
      ...baseStatus,
      proxy: baseStatus.proxy === "missing" ? "error" : baseStatus.proxy
    };
  }
}

export async function getMediaDurationUs(asset: MediaAsset, fallbackUs: number) {
  if (asset.metadata?.durationUs && asset.metadata.durationUs > 0) {
    return asset.metadata.durationUs;
  }

  try {
    const src = await getMediaSourceUrl(asset.path);
    const element = document.createElement(asset.kind === "audio" ? "audio" : "video");
    element.preload = "metadata";
    element.src = src;

    return await new Promise<number>((resolve) => {
      const timeout = window.setTimeout(() => resolve(fallbackUs), 5000);
      element.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve(Number.isFinite(element.duration) && element.duration > 0 ? Math.round(element.duration * 1_000_000) : fallbackUs);
      };
      element.onerror = () => {
        window.clearTimeout(timeout);
        resolve(fallbackUs);
      };
    });
  } catch {
    return fallbackUs;
  }
}

function mediaHasAudio(asset: MediaAsset) {
  return asset.kind === "audio" || Boolean(asset.metadata?.hasAudio);
}

function mediaNeedsProxy(asset: MediaAsset) {
  if (asset.kind !== "video") {
    return false;
  }

  const codec = asset.metadata?.codec.toLowerCase() ?? "";
  return (
    (asset.metadata?.height ?? 0) >= 1440 ||
    (asset.metadata?.width ?? 0) >= 2560 ||
    (asset.metadata?.fps ?? 0) > 30 ||
    codec.includes("hevc") ||
    codec.includes("h265") ||
    codec.includes("av1")
  );
}

function getExtension(path: string) {
  const name = getFileName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
