import type { AudioAdjustment, ClipEffect, ClipTransform, ColorAdjustment, TitleOverlay } from "./timeline";
import type { ColorMode, ExportCodec, ExportContainer, ExportEncoderOptions, ExportFps, ExportQuality, ExportResolution } from "./media";
import type { ProjectSettings } from "./media";

export type CommandType =
  | "execute_batch"
  | "update_project_settings"
  | "add_marker"
  | "update_marker"
  | "delete_marker"
  | "add_title"
  | "update_title"
  | "delete_title"
  | "import_captions"
  | "import_media"
  | "relink_media"
  | "remove_media"
  | "add_track"
  | "update_track"
  | "delete_track"
  | "add_clip"
  | "move_clip"
  | "trim_clip"
  | "set_clip_source_range"
  | "crossfade_clips"
  | "split_clip"
  | "delete_clip"
  | "ripple_delete_clip"
  | "apply_color_adjustment"
  | "apply_audio_adjustment"
  | "apply_clip_speed"
  | "apply_transform"
  | "apply_effect_stack"
  | "apply_lut"
  | "export_timeline";

export type TrackKind = "video" | "audio";
export type TrackMode = "selected_track" | "all_tracks";
export type CommandHistoryMode = "push" | "replace" | "none";

export interface CommandHistoryPolicy {
  mode?: CommandHistoryMode;
  group?: string;
}

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
  trackId?: string;
  name?: string;
  index?: number;
}

export interface RelinkMediaCommand {
  type: "relink_media";
  mediaId: string;
  path: string;
}

export interface UpdateTrackCommand {
  type: "update_track";
  trackId: string;
  name?: string;
  locked?: boolean;
  muted?: boolean;
  visible?: boolean;
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
  speedPercent?: number;
  color?: ColorAdjustment;
  audio?: AudioAdjustment;
  transform?: ClipTransform;
  effects?: ClipEffect[];
  lut?: { lutId: string; strength: number } | null;
}

export interface ExecuteBatchCommand {
  type: "execute_batch";
  label?: string;
  commands: EditorCommand[];
}

export type MarkerCommand =
  | { type: "add_marker"; markerId?: string; timeUs: number; name?: string; color?: string }
  | { type: "update_marker"; markerId: string; timeUs?: number; name?: string; color?: string }
  | { type: "delete_marker"; markerId: string };

export type TitleCommand =
  | { type: "import_captions"; captions: Array<{ text: string; startUs: number; durationUs: number }>; mode?: "append" | "replace"; style?: Pick<Partial<TitleOverlay>, "fontSize" | "color" | "positionX" | "positionY" | "background"> }
  | ({ type: "add_title"; titleId?: string; text: string; startUs: number } & Partial<Omit<TitleOverlay, "id">>)
  | ({ type: "update_title"; titleId: string } & Partial<Omit<TitleOverlay, "id">>)
  | { type: "delete_title"; titleId: string };

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

export interface SetClipSourceRangeCommand { type: "set_clip_source_range"; clipId: string; inUs: number; outUs: number }
export interface CrossfadeClipsCommand { type: "crossfade_clips"; firstClipId: string; secondClipId: string; durationUs: number }

export interface ApplyClipSpeedCommand {
  type: "apply_clip_speed";
  clipId: string;
  speedPercent: number;
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
  rangeStartUs?: number;
  rangeEndUs?: number;
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
  encoderOptions?: ExportEncoderOptions;
  audioEnabled: boolean;
  masterGainDb?: number;
  normalizeAudio?: boolean;
  cleanupAudio?: boolean;
  colorMode: ColorMode;
  overwrite?: boolean;
}

export type EditorCommand = (
  | { type: "update_project_settings"; settings: Partial<ProjectSettings> }
  | ExecuteBatchCommand
  | MarkerCommand
  | TitleCommand
  | ImportMediaCommand
  | RelinkMediaCommand
  | RemoveMediaCommand
  | AddTrackCommand
  | UpdateTrackCommand
  | DeleteTrackCommand
  | AddClipCommand
  | MoveClipCommand
  | TrimClipCommand
  | SetClipSourceRangeCommand
  | CrossfadeClipsCommand
  | SplitClipCommand
  | DeleteClipCommand
  | RippleDeleteClipCommand
  | ApplyColorAdjustmentCommand
  | ApplyAudioAdjustmentCommand
  | ApplyClipSpeedCommand
  | ApplyTransformCommand
  | ApplyEffectStackCommand
  | ApplyLutCommand
  | ExportTimelineCommand
) & {
  history?: CommandHistoryPolicy;
};

export interface CommandEnvelope<T extends EditorCommand = EditorCommand> {
  requestId: string;
  command: T;
  source: "ui" | "shortcut" | "plugin" | "future_ai";
}

export interface CommandResult {
  ok: boolean;
  commandId?: string;
  commandType?: CommandType;
  error?: string;
  data?: unknown;
  undoCount?: number;
  redoCount?: number;
}
