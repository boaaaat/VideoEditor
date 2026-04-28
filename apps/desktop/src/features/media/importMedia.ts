import { open } from "@tauri-apps/plugin-dialog";
import type { CommandResult } from "@ai-video-editor/protocol";
import { executeCommand } from "../commands/commandClient";

const mediaExtensions = ["mp4", "mov", "mkv", "mp3"];

export async function importMediaFiles(): Promise<CommandResult | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return executeCommand({
      type: "import_media",
      paths: ["browser-preview.mp4"],
      copyToProject: false
    });
  }

  const selection = await open({
    multiple: true,
    filters: [{ name: "Media", extensions: mediaExtensions }]
  });

  if (!selection) {
    return null;
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  if (paths.length === 0) {
    return null;
  }

  return executeCommand({
    type: "import_media",
    paths,
    copyToProject: false
  });
}
