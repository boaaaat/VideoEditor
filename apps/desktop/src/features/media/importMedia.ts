import { open } from "@tauri-apps/plugin-dialog";
import type { CommandResult } from "@ai-video-editor/protocol";
import { executeCommand } from "../commands/commandClient";
import { isSupportedMediaPath, pathToMediaAsset, supportedMediaExtensions, type MediaAsset } from "./mediaTypes";

export interface ImportMediaResult {
  command: CommandResult;
  media: MediaAsset[];
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

  return {
    command,
    media: supportedPaths.map(pathToMediaAsset)
  };
}
