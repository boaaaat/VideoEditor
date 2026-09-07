import { open } from "@tauri-apps/plugin-dialog";
import type { CommandResult, MediaMetadata } from "@ai-video-editor/protocol";
import { engineRpc, executeCommand } from "../commands/commandClient";
import { isSupportedMediaPath, pathToMediaAsset, supportedMediaExtensions, type MediaAsset } from "./mediaTypes";
import { loadEditorPreferences } from "../settings";

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
  if (paths.length === 0) {
    return null;
  }
  const unsupported = paths.filter((path) => !isSupportedMediaPath(path));
  if (unsupported.length) throw new Error(`Unsupported media: ${unsupported.join(", ")}`);
  const supportedPaths = [...new Set(paths)];

  const command = await executeCommand({
      type: "import_media",
      paths: supportedPaths,
      copyToProject: loadEditorPreferences().copyMediaToProject
  });

  if (!command.ok) throw new Error(command.error ?? "Import failed");

  const data = command.data as ImportMediaCommandData | undefined;
  const probedMetadata = Array.isArray(data?.media) ? new Map<string, MediaMetadata>() : await probeMediaPaths(supportedPaths);
  const media = Array.isArray(data?.media)
    ? data.media.map((asset) => ({
        ...asset,
        metadata: asset.metadata ?? probedMetadata.get(asset.path)
      }))
    : supportedPaths.map((path) => pathToMediaAsset(path, probedMetadata.get(path)));

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

async function probeMediaPaths(paths: string[]) {
  const results = await Promise.all(
    paths.map(async (path) => {
      const metadata = await probeMediaPath(path).catch(() => undefined);
      return [path, metadata] as const;
    })
  );

  return new Map(results.filter((entry): entry is readonly [string, MediaMetadata] => Boolean(entry[1])));
}
