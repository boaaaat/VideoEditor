export type MediaKind = "video" | "audio";

export interface MediaAsset {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  extension: string;
  importedAt: string;
}

export const supportedMediaExtensions = ["mp4", "mov", "mkv", "mp3"] as const;

export function isSupportedMediaPath(path: string) {
  const extension = getExtension(path);
  return supportedMediaExtensions.includes(extension as (typeof supportedMediaExtensions)[number]);
}

export function pathToMediaAsset(path: string): MediaAsset {
  const name = getFileName(path);
  const extension = getExtension(path);

  return {
    id: `media_${stableHash(path)}_${Date.now()}`,
    name,
    path,
    extension,
    kind: extension === "mp3" ? "audio" : "video",
    importedAt: new Date().toISOString()
  };
}

export function getFileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function getProjectNameFromPath(path: string) {
  const cleanPath = path.replace(/[\\/]project\.aivproj$/i, "");
  return getFileName(cleanPath) || "Untitled Project";
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
