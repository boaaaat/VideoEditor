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

export const defaultColorAdjustment: ColorAdjustment = {
  brightness: 0,
  contrast: 0,
  saturation: 1,
  temperature: 0,
  tint: 0
};
