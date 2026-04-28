export type PluginType = "typescript" | "cpp";

export type PluginPermission =
  | "timeline.read"
  | "timeline.write"
  | "media.read"
  | "media.import"
  | "project.read"
  | "project.write"
  | "export.create"
  | "ui.panel"
  | "ui.command"
  | "color.write"
  | "filesystem.projectOnly";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: PluginType;
  entry?: string;
  permissions: PluginPermission[];
  developerModeRequired?: boolean;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  path: string;
  lastLoadedAt?: string;
  lastError?: string;
}
