export const colorControls = [
  "brightness",
  "contrast",
  "saturation",
  "temperature",
  "tint",
  "lutStrength"
] as const;

export type ColorControl = (typeof colorControls)[number];
