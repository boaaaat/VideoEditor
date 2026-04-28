import type { ColorMode, ExportCodec, ExportContainer, ExportFps, ExportQuality, ExportResolution, GpuStatus, ProjectSettings } from "@ai-video-editor/protocol";

export const exportResolutions: ExportResolution[] = ["source", "custom", "1080p", "1440p", "4k"];
export const exportFpsOptions: ExportFps[] = [24, 25, 30, 50, 60];
export const exportContainers: ExportContainer[] = ["mp4", "mkv"];
export const exportCodecs: ExportCodec[] = ["h264_nvenc", "hevc_nvenc", "av1_nvenc"];
export const exportQualities: ExportQuality[] = ["trash", "low", "medium", "high", "pro_max"];

export const exportQualityLabels: Record<ExportQuality, string> = {
  trash: "Trash",
  low: "Low",
  medium: "Medium",
  high: "High",
  pro_max: "Pro Max"
};

export const exportCodecLabels: Record<ExportCodec, string> = {
  h264_nvenc: "H.264 NVENC",
  hevc_nvenc: "H.265 NVENC",
  av1_nvenc: "AV1 NVENC"
};

export function calculateAutoBitrate(settings: ProjectSettings, quality: ExportQuality, codec: ExportCodec = settings.defaultCodec) {
  const [width, height] = settings.width > 0 && settings.height > 0 ? [settings.width, settings.height] : resolutionSize(settings.resolution);
  const pixelFactor = (width * height) / (1920 * 1080);
  const fpsFactor = Math.max(0.8, settings.fps / 30);
  const hdrFactor = settings.colorMode === "HDR" ? 1.25 : 1;
  const qualityFactor = qualityMultiplier(quality);
  const codecFactor = codecEfficiencyMultiplier(codec);
  return Math.max(2, Math.round(16 * pixelFactor * fpsFactor * hdrFactor * qualityFactor * codecFactor));
}

export function validateExportSettings({
  outputPath,
  codec,
  container,
  colorMode,
  audioEnabled,
  hasAudio,
  width,
  height,
  gpu
}: {
  outputPath: string;
  codec: ExportCodec;
  container: ExportContainer;
  colorMode: ColorMode;
  audioEnabled: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  gpu: GpuStatus | null;
}) {
  const errors: string[] = [];
  if (!outputPath.trim()) {
    errors.push("Choose an output path.");
  }
  if (!exportContainers.includes(container)) {
    errors.push("Choose MP4 or MKV.");
  }
  if (codec === "av1_nvenc" && !gpu?.av1NvencAvailable) {
    errors.push("AV1 NVENC is unsupported on this GPU.");
  }
  if ((codec === "h264_nvenc" || codec === "hevc_nvenc") && gpu?.nvencAvailable === false && "__TAURI_INTERNALS__" in window) {
    errors.push("H.264/H.265 NVENC export requires a supported NVIDIA GPU.");
  }
  if (colorMode === "HDR" && codec === "h264_nvenc") {
    errors.push("HDR export requires H.265 or AV1.");
  }
  if (audioEnabled && !hasAudio) {
    errors.push("Audio is enabled, but no imported media reports audio.");
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    errors.push("Choose a valid output size.");
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    errors.push("Output width and height must be even for hardware encoders.");
  }
  return errors;
}

export async function pickExportOutputPath(container: ExportContainer) {
  const extension = getContainerExtension(container);
  if (!("__TAURI_INTERNALS__" in window)) {
    return `exports/output.${extension}`;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const output = await save({
    title: "Choose export output",
    defaultPath: `output.${extension}`,
    filters: [{ name: container.toUpperCase(), extensions: [extension] }]
  });

  return output ?? "";
}

export function getContainerExtension(container: ExportContainer) {
  return container === "mkv" ? "mkv" : "mp4";
}

function resolutionSize(resolution: ExportResolution) {
  if (resolution === "source" || resolution === "custom") {
    return [1920, 1080] as const;
  }
  if (resolution === "4k") {
    return [3840, 2160] as const;
  }
  if (resolution === "1440p") {
    return [2560, 1440] as const;
  }
  return [1920, 1080] as const;
}

function qualityMultiplier(quality: ExportQuality) {
  switch (quality) {
    case "trash":
      return 0.25;
    case "low":
      return 0.5;
    case "high":
      return 1.6;
    case "pro_max":
      return 2.4;
    case "medium":
    default:
      return 1;
  }
}

function codecEfficiencyMultiplier(codec: ExportCodec) {
  switch (codec) {
    case "hevc_nvenc":
      return 0.72;
    case "av1_nvenc":
      return 0.58;
    case "h264_nvenc":
    default:
      return 1;
  }
}
