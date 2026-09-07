import type { CommandResult, EditorCommand, ProjectSettings } from "@ai-video-editor/protocol";
import { parseSubtitles, serializeSubtitles, type SubtitleFormat } from "@ai-video-editor/protocol";
import { engineRpc, executeCommand, isEngineEditing, type CommandHistoryStatus } from "../commands/commandClient";
import { getMediaPreviewFrameDataUrl } from "../media/mediaTypes";
import type { ProjectSnapshot } from "../projects/projectActions";
import { validateMediaPaths } from "../projects/projectActions";
import { timelineContentDurationUs } from "../timeline/timing";
import { pluginInvoke, runEditorPlugin } from "../plugins/runtime";
import { getCompositionFrame } from "../playback/composition";

export interface AgentRequest { requestId: string; method: string; params: Record<string, unknown> }
export interface AgentContext {
  snapshot: ProjectSnapshot;
  playheadUs: number;
  playing: boolean;
  unavailable: boolean;
  applySnapshot: (snapshot: ProjectSnapshot, switchedProject: boolean, rememberProject?: boolean) => void;
  applyHistory: (history: CommandHistoryStatus) => void;
  setPlayback: (timeUs?: number, playing?: boolean, showPreview?: boolean) => void;
}

let agentApplying = false;
export function isAgentApplying() { return agentApplying; }

/** Run on the UI's command path so project snapshots and agent edits cannot race. */
export async function handleAgentRequest(request: AgentRequest, context: AgentContext, setBusy: (busy: boolean) => void) {
  if (agentApplying || context.unavailable || isEngineEditing()) throw new Error("Editor is busy. No action was taken; retry when idle.");
  const { method, params } = request;
  const pluginProjectPath = () => {
    if (params.scope === "user") return undefined;
    if (!context.snapshot.project.path) throw new Error("Open a project or choose user scope for plugins");
    return context.snapshot.project.path;
  };
  if (method === "plugin.list") return pluginInvoke("plugins_list", { projectPath: pluginProjectPath() });
  if (method === "plugin.inspect") return pluginInvoke("plugins_inspect", { folder: params.folder });
  if (method === "editor.state") return { ...context.snapshot, contentDurationUs: timelineContentDurationUs(context.snapshot.timeline), playheadUs: context.playheadUs, playing: context.playing, history: await engineRpc("command.history") };
  if (method === "timeline.state") return context.snapshot.timeline;
  if (method === "timeline.frame") {
    if (!context.snapshot.project.path) throw new Error("Open a project before inspecting its composition");
    return getCompositionFrame({timeline:context.snapshot.timeline,mediaAssets:context.snapshot.mediaAssets,projectSettings:context.snapshot.projectSettings,projectPath:context.snapshot.project.path,timeUs:finiteTime(params.timeUs ?? context.playheadUs),maxWidth:typeof params.maxWidth === "number" ? params.maxWidth : 1280});
  }
  if (method === "media.index") return { media: context.snapshot.mediaAssets };
  if (method === "media.check") {
    const missing = new Set(await validateMediaPaths(context.snapshot.mediaAssets.map((asset)=>asset.path),context.snapshot.project.path));
    return {media:context.snapshot.mediaAssets.map((asset)=>({id:asset.id,name:asset.name,path:asset.path,missing:missing.has(asset.path)})),missingCount:missing.size,description:"Checks file availability; use media_probe to validate stream metadata."};
  }
  if (method === "ai.proposals") return { proposals: context.snapshot.aiProposals };
  if (["command.history", "media.probe", "export.status"].includes(method)) return engineRpc(method, params);
  if (method === "subtitles.export") {
    if (!context.snapshot.project.path) throw new Error("Open a project before exporting captions");
    const result = serializeSubtitles(context.snapshot.timeline.titles ?? [], params.format as SubtitleFormat);
    if (params.path) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_subtitle_file", {path: params.path, content: result.content, overwrite: params.overwrite === true});
    }
    return {...result, format: params.format, path: params.path};
  }
  if (method === "media.frame") {
    const asset = context.snapshot.mediaAssets.find((item) => item.id === params.mediaId);
    if (!asset || asset.kind !== "video") throw new Error("Choose an imported video media ID");
    const timeUs = finiteTime(params.timeUs ?? 0);
    if (asset.metadata?.durationUs && timeUs >= asset.metadata.durationUs) throw new Error("Frame time is past the source duration");
    const dataUrl = await getMediaPreviewFrameDataUrl(asset, timeUs);
    if (!dataUrl) throw new Error("Could not decode a source frame");
    return { dataUrl, mediaId: asset.id, timeUs, description: "Source frame before timeline effects" };
  }
  if (method === "editor.playback") {
    if (!context.snapshot.project.path) throw new Error("Open a project before controlling playback");
    const timeUs = params.timeUs === undefined ? context.playheadUs : Math.min(context.snapshot.timeline.durationUs, finiteTime(params.timeUs));
    const playing = (typeof params.playing === "boolean" ? params.playing : context.playing) && timeUs < timelineContentDurationUs(context.snapshot.timeline);
    context.setPlayback(timeUs, playing, true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return { timeUs, playing };
  }

  agentApplying = true;
  setBusy(true);
  context.setPlayback(undefined, false);
  try {
    if (method.startsWith("plugin.")) {
      const projectPath = pluginProjectPath();
      let result: unknown;
      if (method === "plugin.run") {
        if (context.snapshot.project.path) await engineRpc("project.save_state", context.snapshot);
        result = await runEditorPlugin({ pluginId: String(params.pluginId), projectPath, snapshot: context.snapshot, playheadUs: context.playheadUs, parameters: params.parameters as Record<string, unknown> | undefined });
        if (context.snapshot.project.path) context.applySnapshot(await engineRpc<ProjectSnapshot>("project.state"), false);
      } else {
        const commands: Record<string, string> = { "plugin.install": "plugins_install", "plugin.enable": "plugins_set_enabled", "plugin.remove": "plugins_remove", "plugin.developer_mode": "plugins_set_developer_mode" };
        if (!commands[method]) throw new Error("Unknown plugin operation");
        result = await pluginInvoke(commands[method], { ...params, projectPath });
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      return result;
    }
    const switching = method === "project.open" || method === "project.create";
    if (!switching && !context.snapshot.project.path) throw new Error("Create or open a project first");
    // Flush settings and any other local changes before the agent edits the engine state.
    if (context.snapshot.project.path) await engineRpc("project.save_state", context.snapshot);
    let result: unknown;
    if (method === "subtitles.import") {
      if (typeof params.content !== "string") throw new Error("Subtitle content must be text");
      const parsed = parseSubtitles(params.content, params.format as SubtitleFormat, params.offsetUs === undefined ? 0 : params.offsetUs as number);
      const imported = await executeCommand({type:"import_captions", captions:parsed.cues, mode:params.mode as "append" | "replace" | undefined});
      if (!imported.ok) throw new Error(imported.error ?? "Caption import failed");
      result = {count:parsed.cues.length, warnings:parsed.warnings};
    } else if (method === "command.execute") {
      if ((params as unknown as EditorCommand).type === "export_timeline") throw new Error("Use export.start for rendering");
      result = await executeCommand(params as unknown as EditorCommand);
      if (!(result as CommandResult).ok) throw new Error((result as CommandResult).error ?? "Edit failed");
    } else if (method === "project.save") {
      result = { saved: true, project: context.snapshot.project };
    } else if (method === "project.settings") {
      const settings = { ...context.snapshot.projectSettings, ...params } as ProjectSettings;
      if (![24, 25, 30, 50, 60].includes(settings.fps) || !Number.isInteger(settings.width) || !Number.isInteger(settings.height) || settings.width < 16 || settings.height < 16 || settings.width > 8192 || settings.height > 8192) throw new Error("Use supported fps and dimensions from 16 to 8192");
      result = await executeCommand({ type: "update_project_settings", settings: params as Partial<ProjectSettings> });
      if (!(result as CommandResult).ok) throw new Error((result as CommandResult).error ?? "Settings update failed");
    } else if (method === "export.start") {
      const settings = context.snapshot.projectSettings;
      result = await engineRpc("export.start", {
        ...settings, codec: settings.defaultCodec, container: settings.defaultContainer, quality: "high", overwrite: false,
        ...params, timeline: context.snapshot.timeline, mediaAssets: context.snapshot.mediaAssets
      });
    } else if (["project.open", "project.create", "command.undo", "command.redo", "export.cancel", "ai.proposal.create", "ai.proposal.apply", "ai.proposal.reject"].includes(method)) {
      result = await engineRpc(method, params);
    } else throw new Error(`Unsupported editor method: ${method}`);
    const snapshot = await engineRpc<ProjectSnapshot>("project.state");
    context.applySnapshot(snapshot, switching, params.remember !== false);
    context.applyHistory(await engineRpc<CommandHistoryStatus>("command.history"));
    // Let React commit the new snapshot before the bridge can deliver another request.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    return result;
  } finally {
    agentApplying = false;
    setBusy(false);
  }
}

function finiteTime(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Time must be a nonnegative integer in microseconds");
  return value;
}
