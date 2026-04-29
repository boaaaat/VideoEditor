export type TimelineTrackKind = "video" | "audio";

export interface Timeline {
  id: string;
  name: string;
  fps: number;
  durationUs: number;
  tracks: TimelineTrack[];
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TimelineTrackKind;
  index: number;
  locked: boolean;
  muted: boolean;
  visible: boolean;
  clips: TimelineClip[];
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  trackId: string;
  startUs: number;
  inUs: number;
  outUs: number;
  color: ColorAdjustment;
  audio?: AudioAdjustment;
  transform?: ClipTransform;
  effects?: ClipEffect[];
  lut?: ClipLut;
}

export interface ColorAdjustment {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
}

export interface ClipLut {
  lutId: string;
  strength: number;
}

export interface ClipTransform {
  enabled: boolean;
  scale: number;
  positionX: number;
  positionY: number;
  rotation: number;
  opacity: number;
}

export type ClipEffectType = "blur" | "sharpen" | "vignette" | "grayscale";

export interface ClipEffect {
  id: string;
  type: ClipEffectType;
  label: string;
  enabled: boolean;
  amount: number;
}

export interface AudioAdjustment {
  gainDb: number;
  muted: boolean;
  fadeInUs: number;
  fadeOutUs: number;
  normalize: boolean;
  cleanup: boolean;
}

export const defaultColorAdjustment: ColorAdjustment = {
  brightness: 0,
  contrast: 0,
  saturation: 1,
  temperature: 0,
  tint: 0
};

export const defaultAudioAdjustment: AudioAdjustment = {
  gainDb: 0,
  muted: false,
  fadeInUs: 0,
  fadeOutUs: 0,
  normalize: false,
  cleanup: false
};

export const defaultClipTransform: ClipTransform = {
  enabled: true,
  scale: 1,
  positionX: 0,
  positionY: 0,
  rotation: 0,
  opacity: 1
};

export const defaultClipEffects: ClipEffect[] = [
  { id: "blur", type: "blur", label: "Blur", enabled: false, amount: 0 },
  { id: "sharpen", type: "sharpen", label: "Sharpen", enabled: false, amount: 0 },
  { id: "vignette", type: "vignette", label: "Vignette", enabled: false, amount: 0 },
  { id: "grayscale", type: "grayscale", label: "Grayscale", enabled: false, amount: 0 }
];
