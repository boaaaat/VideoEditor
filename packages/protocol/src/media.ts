export type ColorMode = "SDR" | "HDR";
export type ExportQuality = "trash" | "low" | "medium" | "high" | "pro_max";
export type ExportCodec = "h264_nvenc" | "hevc_nvenc" | "av1_nvenc";
export type ExportContainer = "mp4" | "mkv";
export type ExportResolution = "source" | "custom" | "1080p" | "1440p" | "4k";
export type ExportFps = 24 | 25 | 30 | 50 | 60;

export interface MediaMetadata {
  path: string;
  width: number;
  height: number;
  fps: number;
  durationUs: number;
  codec: string;
  pixelFormat: string;
  colorTransfer: string;
  hdr: boolean;
  hasAudio: boolean;
  audioStreamCount?: number;
  audioStreams?: MediaAudioStream[];
}

export interface MediaAudioStream {
  index: number;
  codec: string;
  channels: number;
  title?: string;
}

export interface MediaIntelligence {
  summary: {
    durationUs: number;
    codec: string;
    resolution: {
      width: number;
      height: number;
    };
    fps: number;
    hdr: boolean;
    hasAudio: boolean;
  };
  thumbnails: {
    status: "ready-on-demand" | "not-applicable" | "placeholder";
  };
  previewFrames: {
    status: "ready-on-demand" | "not-applicable" | "placeholder";
  };
  transcript: {
    status: "placeholder" | "pending" | "ready" | "failed";
    text: string;
    language: string;
  };
  sceneCuts: {
    status: "placeholder" | "pending" | "ready" | "failed";
    cuts: number[];
  };
}

export interface ProjectSettings {
  resolution: ExportResolution;
  width: number;
  height: number;
  fps: ExportFps;
  colorMode: ColorMode;
  bitrateMbps: number;
  defaultCodec: ExportCodec;
  defaultContainer: ExportContainer;
  audioEnabled: boolean;
  masterGainDb: number;
  normalizeAudio: boolean;
  cleanupAudio: boolean;
}

export interface PreviewState {
  attached: boolean;
  parentHwnd?: string;
  childHwnd?: string;
  state: "playing" | "paused";
  mediaId?: string;
  mediaPath?: string;
  codec: string;
  decodeMode: "idle" | "cuda/nvdec" | "software" | string;
  renderMode?: "fallback" | "engine-frame" | "native-d3d" | string;
  frameNumber?: number;
  renderedFrames?: number;
  frameDataUrl?: string;
  lastFramePlayheadUs?: number;
  lastFrameDecodeMs?: number;
  droppedFrames: number;
  previewFps: number;
  quality: string;
  colorMode: ColorMode;
  hdrOutputAvailable: boolean;
  warning?: string;
}

export interface ExportStatus {
  jobId: string | null;
  outputPath?: string;
  state: "idle" | "running" | "completed" | "cancelled" | "error";
  progress: number;
  resolution?: ExportResolution;
  width?: number;
  height?: number;
  fps?: number;
  durationUs?: number;
  codec?: ExportCodec;
  container?: ExportContainer;
  quality?: ExportQuality;
  bitrateMbps?: number;
  audioEnabled?: boolean;
  colorMode?: ColorMode;
  ffmpegCommand?: string;
  logs: string[];
  cancelled?: boolean;
}
