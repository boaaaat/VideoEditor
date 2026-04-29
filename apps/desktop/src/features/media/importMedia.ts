import { open } from "@tauri-apps/plugin-dialog";
import type { CommandResult, MediaMetadata } from "@ai-video-editor/protocol";
import { engineRpc, executeCommand } from "../commands/commandClient";
import { isSupportedMediaPath, pathToMediaAsset, supportedMediaExtensions, type MediaAsset } from "./mediaTypes";

export interface ImportMediaResult {
  command: CommandResult;
  media: MediaAsset[];
}

interface ImportMediaCommandData {
  media?: MediaAsset[];
}

export async function importMediaFiles(): Promise<ImportMediaResult | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return importMediaPaths(["browser-preview.mp4"]);
  }

  const selection = await open({
    multiple: true,
    filters: [{ name: "Media", extensions: [...supportedMediaExtensions] }]
  });

  if (!selection) {
    return null;
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  return importMediaPaths(paths);
}

export async function importMediaPaths(paths: string[]): Promise<ImportMediaResult | null> {
  const supportedPaths = paths.filter(isSupportedMediaPath);
  if (supportedPaths.length === 0) {
    return null;
  }

  const command = await executeCommand({
      type: "import_media",
      paths: supportedPaths,
      copyToProject: false
  });

  const data = command.data as ImportMediaCommandData | undefined;
  const media = Array.isArray(data?.media)
    ? data.media
    : await Promise.all(
        supportedPaths.map(async (path) => {
          const metadata = await probeMediaPath(path).catch(() => undefined);
          return pathToMediaAsset(path, metadata);
        })
      );

  return {
    command,
    media
  };
}

export function probeMediaPath(path: string) {
  if ("__TAURI_INTERNALS__" in window) {
    return import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<MediaMetadata>("media_probe", { path }))
      .catch(() => engineRpc<MediaMetadata>("media.probe", { path }));
  }

  return engineRpc<MediaMetadata>("media.probe", { path });
}
