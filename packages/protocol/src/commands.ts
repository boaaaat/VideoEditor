import type { AudioAdjustment, ClipEffect, ClipTransform, ColorAdjustment } from "./timeline";
import type { ColorMode, ExportCodec, ExportContainer, ExportFps, ExportQuality, ExportResolution } from "./media";

export type CommandType =
  | "import_media"
  | "remove_media"
  | "add_track"
  | "delete_track"
  | "add_clip"
  | "move_clip"
  | "trim_clip"
  | "split_clip"
  | "delete_clip"
  | "ripple_delete_clip"
  | "apply_color_adjustment"
  | "apply_audio_adjustment"
  | "apply_transform"
  | "apply_effect_stack"
  | "apply_lut"
  | "export_timeline";

export type TrackKind = "video" | "audio";
export type TrackMode = "selected_track" | "all_tracks";

export interface ImportMediaCommand {
  type: "import_media";
  paths: string[];
  copyToProject?: boolean;
}

export interface RemoveMediaCommand {
  type: "remove_media";
  mediaId: string;
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
  clipId?: string;
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

export interface ApplyAudioAdjustmentCommand {
  type: "apply_audio_adjustment";
  clipId: string;
  adjustment: Partial<AudioAdjustment>;
}

export interface ApplyTransformCommand {
  type: "apply_transform";
  clipId: string;
  transform: Partial<ClipTransform>;
}

export interface ApplyEffectStackCommand {
  type: "apply_effect_stack";
  clipId: string;
  effects: ClipEffect[];
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
  durationUs?: number;
  codec: ExportCodec;
  container: ExportContainer;
  quality: ExportQuality;
  bitrateMbps: number;
  audioEnabled: boolean;
  masterGainDb?: number;
  normalizeAudio?: boolean;
  cleanupAudio?: boolean;
  colorMode: ColorMode;
  overwrite?: boolean;
}

export type EditorCommand =
  | ImportMediaCommand
  | RemoveMediaCommand
  | AddTrackCommand
  | DeleteTrackCommand
  | AddClipCommand
  | MoveClipCommand
  | TrimClipCommand
  | SplitClipCommand
  | DeleteClipCommand
  | RippleDeleteClipCommand
  | ApplyColorAdjustmentCommand
  | ApplyAudioAdjustmentCommand
  | ApplyTransformCommand
  | ApplyEffectStackCommand
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
