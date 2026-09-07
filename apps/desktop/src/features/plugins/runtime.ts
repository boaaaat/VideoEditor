import type { AiEditProposal, EditorCommand, InstalledPlugin, PluginManifest } from "@ai-video-editor/protocol";
import type { ProjectSnapshot } from "../projects/projectActions";
import { engineRpc } from "../commands/commandClient";

export interface PluginLog { level: "info" | "warning" | "error"; message: string }
export interface PluginRunResult { summary: string; output?: string; commands: EditorCommand[]; logs: PluginLog[]; proposal?: AiEditProposal }
export interface PluginListing { plugins: InstalledPlugin[]; developerMode: boolean }
export type PluginScope = "project" | "user";

export async function pluginInvoke<T>(command: string, args: Record<string, unknown> = {}) {
  if (!("__TAURI_INTERNALS__" in window)) throw new Error("Plugin packages require the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export function pluginParameters(manifest: PluginManifest, values: Record<string, unknown>) {
  const parameters: Record<string, unknown> = {};
  const fields = manifest.parameters ?? [];
  if (Object.keys(values).some((id) => !fields.some((field) => field.id === id))) throw new Error("Unknown plugin parameter");
  for (const field of fields) {
    const value = values[field.id] ?? field.default ?? field.options?.[0] ?? (field.type === "number" ? 0 : field.type === "boolean" ? false : "");
    if (typeof value !== field.type) throw new Error(`${field.label} must be a ${field.type}`);
    if (typeof value === "number" && (!Number.isFinite(value) || value < (field.min ?? -Infinity) || value > (field.max ?? Infinity))) throw new Error(`${field.label} is outside its allowed range`);
    if (typeof value === "string" && (value.length > 4000 || (field.required && !value.trim()) || (field.options && !field.options.includes(value)))) throw new Error(`${field.label} has an invalid value`);
    parameters[field.id] = value;
  }
  return parameters;
}

const editingTypes = new Set(["add_track", "update_track", "delete_track", "add_clip", "move_clip", "trim_clip", "set_clip_source_range", "split_clip", "delete_clip", "ripple_delete_clip", "apply_color_adjustment", "apply_lut", "apply_audio_adjustment", "apply_clip_speed", "apply_transform", "apply_effect_stack", "add_marker", "update_marker", "delete_marker", "add_title", "update_title", "delete_title", "import_captions", "crossfade_clips"]);

function validateResult(manifest: PluginManifest, value: unknown): PluginRunResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plugin must return a result object");
  const raw = value as Record<string, unknown>;
  if (raw.error) throw new Error(String(raw.error));
  if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error("Plugin output exceeds 2 MB");
  const commands = raw.commands ?? [];
  if (!Array.isArray(commands) || commands.length > 500) throw new Error("Plugin output must contain at most 500 editing commands");
  for (const command of commands) {
    if (!command || typeof command !== "object" || !editingTypes.has(command.type) || "history" in command) throw new Error("Plugin returned an unsupported command or attempted to bypass undo");
    const permission = ["apply_color_adjustment", "apply_lut"].includes(command.type) ? "color.write" : "timeline.write";
    if (!manifest.permissions.includes(permission) && !(permission === "color.write" && manifest.permissions.includes("timeline.write"))) throw new Error(`Plugin did not request ${permission}`);
  }
  const summary = typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : `${manifest.name} completed`;
  const output = typeof raw.output === "string" ? raw.output.slice(0, 100_000) : undefined;
  return { summary, output, commands: commands as EditorCommand[], logs: [] };
}

// A separate loopback origin isolates browser storage and the Tauri bridge.
// Its response policy blocks networking and imports outside the plugin package.
export async function runJavaScriptPlugin(pluginId: string, projectPath: string | undefined, context: unknown, signal?: AbortSignal): Promise<{ result: unknown; logs: PluginLog[] }> {
  if (new TextEncoder().encode(JSON.stringify(context)).length > 2 * 1024 * 1024) throw new Error("Plugin input exceeds 2 MB");
  const session = await pluginInvoke<{url:string;runId:string}>("plugins_start_script", {pluginId,projectPath});
  const origin = new URL(session.url).origin;
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    const nonce = session.runId;
    frame.sandbox.add("allow-scripts", "allow-same-origin");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.src = session.url;
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      window.removeEventListener("message", receive);
      signal?.removeEventListener("abort", cancel);
      frame.contentWindow?.postMessage({kind: "cancel", nonce}, "*");
      frame.remove();
      void pluginInvoke("plugins_stop_script", {runId: session.runId}).catch(() => undefined);
    };
    const fail = (error: unknown) => { if (!settled) { cleanup(); reject(error); } };
    const cancel = () => fail(new Error("Plugin run cancelled"));
    const timeout = window.setTimeout(() => fail(new Error("Plugin exceeded the 5 second time limit")), 5000);
    function receive(event: MessageEvent) {
      if (event.source !== frame.contentWindow || event.origin !== origin || event.data?.nonce !== nonce) return;
      if (event.data.kind === "ready") frame.contentWindow?.postMessage({ kind: "run", nonce, context }, "*");
      if (event.data.kind !== "result") return;
      const payload = event.data.payload;
      if (payload?.error) { fail(new Error(String(payload.error))); return; }
      const logs = Array.isArray(payload?.logs) ? payload.logs.slice(0, 200).filter((entry: unknown) => entry && typeof entry === "object").map((entry: PluginLog) => ({ message: String(entry.message).slice(0, 2000), level: ["warning", "error"].includes(entry.level) ? entry.level : "info" as const })) : [];
      cleanup(); resolve({ result: payload?.result, logs });
    }
    window.addEventListener("message", receive);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel(); else document.body.append(frame);
  });
}

export async function runEditorPlugin({ pluginId, projectPath, snapshot, playheadUs, parameters = {}, signal }: {
  pluginId: string; projectPath?: string; snapshot: ProjectSnapshot; playheadUs: number; parameters?: Record<string, unknown>; signal?: AbortSignal;
}): Promise<PluginRunResult> {
  const loaded = await pluginInvoke<InstalledPlugin & { source?: string }>("plugins_load", { pluginId, projectPath });
  const manifest = loaded.manifest;
  const context = {
    apiVersion: 1, playheadUs, parameters: pluginParameters(manifest, parameters),
    ...(manifest.permissions.includes("timeline.read") ? { timeline: snapshot.timeline } : {}),
    ...(manifest.permissions.includes("media.read") ? { media: snapshot.mediaAssets } : {}),
    ...(manifest.permissions.includes("project.read") ? { project: snapshot.project, projectSettings: snapshot.projectSettings } : {})
  };
  try {
    const raw = manifest.type === "cpp"
      ? { result: await pluginInvoke<unknown>("plugins_run_native", { pluginId, projectPath, context }), logs: [] }
      : await runJavaScriptPlugin(pluginId, projectPath, context, signal);
    if (signal?.aborted) throw new Error("Plugin run cancelled");
    const result = validateResult(manifest, raw.result);
    result.logs = raw.logs;
    if (result.commands.length) {
      if (!snapshot.project.path) throw new Error("Open a project before a plugin proposes edits");
      result.proposal = await engineRpc<AiEditProposal>("ai.proposal.create", { goal: `Plugin: ${manifest.name}`, explanation: result.summary, commands: result.commands });
    }
    await pluginInvoke("plugins_record_result", { pluginId, projectPath, error: null });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pluginInvoke("plugins_record_result", { pluginId, projectPath, error: message }).catch(() => undefined);
    throw new Error(message);
  }
}
