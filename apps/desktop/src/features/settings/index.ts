import type { ExportFps, MediaMetadata, ProjectSettings } from "@ai-video-editor/protocol";
import { calculateAutoBitrate } from "../export";

export interface EditorPreferences {
  copyMediaToProject: boolean;
  autosaveDelayMs: number;
}

export const defaultEditorPreferences: EditorPreferences = {
  copyMediaToProject: false,
  autosaveDelayMs: 4500
};

const preferencesKey = "ai-video-editor.preferences.v1";
export function loadEditorPreferences(): EditorPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(preferencesKey) ?? "{}");
    return {
      copyMediaToProject: stored.copyMediaToProject === true,
      autosaveDelayMs: [4500, 10000, 30000].includes(stored.autosaveDelayMs) ? stored.autosaveDelayMs : 4500
    };
  } catch { return { ...defaultEditorPreferences }; }
}

export function saveEditorPreferences(preferences: EditorPreferences) {
  localStorage.setItem(preferencesKey, JSON.stringify(preferences));
}

export const defaultProjectSettings: ProjectSettings = {
  resolution: "custom",
  width: 1920,
  height: 1080,
  fps: 30,
  colorMode: "SDR",
  bitrateMbps: 9,
  defaultCodec: "h264_nvenc",
  defaultContainer: "mp4",
  audioEnabled: true,
  masterGainDb: 0,
  normalizeAudio: false,
  cleanupAudio: false
};

export function seedProjectSettingsFromMetadata(metadata: MediaMetadata): ProjectSettings {
  const settings: ProjectSettings = {
    resolution: "source",
    width: metadata.width > 0 ? metadata.width : defaultProjectSettings.width,
    height: metadata.height > 0 ? metadata.height : defaultProjectSettings.height,
    fps: fpsFromMetadata(metadata),
    colorMode: metadata.hdr ? "HDR" : "SDR",
    bitrateMbps: defaultProjectSettings.bitrateMbps,
    defaultCodec: metadata.hdr ? "hevc_nvenc" : "h264_nvenc",
    defaultContainer: "mp4",
    audioEnabled: metadata.hasAudio,
    masterGainDb: defaultProjectSettings.masterGainDb,
    normalizeAudio: defaultProjectSettings.normalizeAudio,
    cleanupAudio: defaultProjectSettings.cleanupAudio
  };

  return {
    ...settings,
    bitrateMbps: calculateAutoBitrate(settings, "medium", settings.defaultCodec)
  };
}

export function resolutionFromMetadata(metadata: MediaMetadata): ProjectSettings["resolution"] {
  if (metadata.height >= 2160 || metadata.width >= 3840) {
    return "4k";
  }
  if (metadata.height >= 1440 || metadata.width >= 2560) {
    return "1440p";
  }
  return "1080p";
}

export function fpsFromMetadata(metadata: MediaMetadata): ExportFps {
  const supported: ExportFps[] = [24, 25, 30, 50, 60];
  if (!Number.isFinite(metadata.fps) || metadata.fps <= 0) {
    return 30;
  }

  return supported.reduce((closest, value) => (Math.abs(value - metadata.fps) < Math.abs(closest - metadata.fps) ? value : closest), 30);
}
