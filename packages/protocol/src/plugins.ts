export type PluginType = "typescript" | "cpp";

export type PluginPermission =
  | "timeline.read"
  | "timeline.write"
  | "media.read"
  | "project.read"
  | "ui.panel"
  | "ui.command"
  | "color.write";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  type: PluginType;
  entry: string;
  permissions: PluginPermission[];
  developerModeRequired?: boolean;
  description?: string;
  parameters?: PluginParameter[];
}

export interface PluginParameter {
  id: string;
  label: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  path: string;
  lastLoadedAt?: string;
  lastError?: string;
  lastRunAt?: number;
  fingerprint?: string;
  invalid?: boolean;
}
