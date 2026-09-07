import type { EditorCommand, MediaMetadata, ProjectSettings, Timeline } from "@ai-video-editor/protocol";

export interface EditorPluginContext {
  apiVersion: 1;
  playheadUs: number;
  parameters: Record<string, string | number | boolean>;
  /** Available with timeline.read. */
  timeline?: Timeline;
  /** Available with media.read. */
  media?: Array<{ id: string; name: string; path: string; kind: "video" | "audio"; metadata?: MediaMetadata }>;
  /** Available with project.read. */
  project?: { name: string; path?: string; manifestPath?: string };
  projectSettings?: ProjectSettings;
  log(message: string, level?: "info" | "warning" | "error"): void;
}
export interface EditorPluginResult {
  summary: string;
  output?: string;
  /** Proposed edits; applied only after review. Do not include history fields. */
  commands?: EditorCommand[];
}
export type EditorPlugin = (context: EditorPluginContext) => EditorPluginResult | Promise<EditorPluginResult>;
