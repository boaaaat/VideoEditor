export type AppLogLevel = "info" | "success" | "warning" | "error" | "debug";

export type AppLogSource = "app" | "ui" | "project" | "media" | "timeline" | "audio" | "export" | "engine" | "ai" | "plugin";

export interface AppLogEntry {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  source: AppLogSource;
  message: string;
  details?: Record<string, unknown>;
}

export interface LogStatusOptions {
  level?: AppLogLevel;
  source?: AppLogSource;
  details?: Record<string, unknown>;
}

export type LogStatus = (message: string, options?: LogStatusOptions) => void;

export function createAppLogEntry(message: string, options: LogStatusOptions = {}): AppLogEntry {
  return {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level: options.level ?? "info",
    source: options.source ?? "ui",
    message,
    details: options.details
  };
}

export function formatAppLogEntry(entry: AppLogEntry) {
  const details = entry.details ? ` ${JSON.stringify(entry.details)}` : "";
  return `[${entry.timestamp}] [${entry.level}] [${entry.source}] ${entry.message}${details}`;
}

export async function appendProjectLog(entry: AppLogEntry, projectPath?: string) {
  if (!projectPath) {
    return;
  }

  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("Project log file persistence unavailable in browser preview");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_app_log", { projectPath, entry });
}
