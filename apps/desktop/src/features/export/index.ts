export const exportResolutions = ["1080p", "1440p", "4k"] as const;
export const exportFpsOptions = [24, 25, 30, 50, 60] as const;

export type ExportResolution = (typeof exportResolutions)[number];
export type ExportFps = (typeof exportFpsOptions)[number];
