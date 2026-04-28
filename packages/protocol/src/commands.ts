import type { ColorAdjustment } from "./timeline";
import type { ColorMode, ExportCodec, ExportContainer, ExportFps, ExportQuality, ExportResolution } from "./media";

export type CommandType =
  | "import_media"
  | "add_track"
  | "delete_track"
  | "add_clip"
  | "move_clip"
  | "trim_clip"
  | "split_clip"
  | "delete_clip"
  | "ripple_delete_clip"
  | "apply_color_adjustment"
  | "apply_lut"
  | "export_timeline";

export type TrackKind = "video" | "audio";
export type TrackMode = "selected_track" | "all_tracks";

export interface ImportMediaCommand {
  type: "import_media";
  paths: string[];
  copyToProject?: boolean;
}

export interface AddTrackCommand {
  type: "add_track";
  kind: TrackKind;
  name?: string;
  index?: number;
}

export interface DeleteTrackCommand {
  type: "delete_track";
  trackId: string;
}

export interface AddClipCommand {
  type: "add_clip";
  mediaId: string;
  trackId: string;
  startUs: number;
  inUs?: number;
  outUs?: number;
}

export interface MoveClipCommand {
  type: "move_clip";
  clipId: string;
  trackId: string;
  startUs: number;
  snapping?: boolean;
}

export interface TrimClipCommand {
  type: "trim_clip";
  clipId: string;
  edge: "start" | "end";
  timeUs: number;
}

export interface SplitClipCommand {
  type: "split_clip";
  clipId?: string;
  playheadUs: number;
}

export interface DeleteClipCommand {
  type: "delete_clip";
  clipId: string;
}

export interface RippleDeleteClipCommand {
  type: "ripple_delete_clip";
  clipId: string;
  trackMode: TrackMode;
}

export interface ApplyColorAdjustmentCommand {
  type: "apply_color_adjustment";
  clipId: string;
  adjustment: Partial<ColorAdjustment>;
}

export interface ApplyLutCommand {
  type: "apply_lut";
  clipId: string;
  lutId: string | null;
  strength: number;
}

export interface ExportTimelineCommand {
  type: "export_timeline";
  outputPath: string;
  resolution: ExportResolution;
  width: number;
  height: number;
  fps: ExportFps;
  codec: ExportCodec;
  container: ExportContainer;
  quality: ExportQuality;
  bitrateMbps: number;
  audioEnabled: boolean;
  colorMode: ColorMode;
}

export type EditorCommand =
  | ImportMediaCommand
  | AddTrackCommand
  | DeleteTrackCommand
  | AddClipCommand
  | MoveClipCommand
  | TrimClipCommand
  | SplitClipCommand
  | DeleteClipCommand
  | RippleDeleteClipCommand
  | ApplyColorAdjustmentCommand
  | ApplyLutCommand
  | ExportTimelineCommand;

export interface CommandEnvelope<T extends EditorCommand = EditorCommand> {
  requestId: string;
  command: T;
  source: "ui" | "shortcut" | "plugin" | "future_ai";
}

export interface CommandResult {
  ok: boolean;
  commandId?: string;
  error?: string;
  data?: unknown;
}
