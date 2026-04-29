import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  Blocks,
  Bot,
  Clapperboard,
  Download,
  Home,
  Keyboard,
  Palette,
  Puzzle,
  WandSparkles
} from "lucide-react";
import type { AiEditProposal, EngineStatus, MediaMetadata, ProjectSettings, Timeline } from "@ai-video-editor/protocol";
import { Tabs, type TabItem } from "../components/Tabs";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import { LogsDrawer, logsToText } from "../components/LogsDrawer";
import { engineRpc, getEngineStatus, type CommandExecutionEventDetail } from "../features/commands/commandClient";
import { isTypingTarget, shortcutDefinitions } from "../features/commands/shortcuts";
import { appendProjectLog, createAppLogEntry, type AppLogEntry, type AppLogSource, type LogStatusOptions } from "../features/logging/appLog";
import { importMediaFiles, type ImportMediaResult } from "../features/media/importMedia";
import type { MediaAsset } from "../features/media/mediaTypes";
import {
  loadProjectSnapshot,
  loadRecentProjects,
  saveProjectSnapshot,
  saveRecentProject,
  validateMediaPaths,
  type ActiveProject,
  type ProjectSnapshot
} from "../features/projects/projectActions";
import { defaultProjectSettings, seedProjectSettingsFromMetadata } from "../features/settings";
import { starterTimeline } from "../features/timeline/mockTimeline";
import { TopBar } from "./topbar/TopBar";
import { HomeTab } from "./tabs/HomeTab";
import { EditTab } from "./tabs/EditTab";
import { AudioTab } from "./tabs/AudioTab";
import { ColorTab } from "./tabs/ColorTab";
import { EffectsTab } from "./tabs/EffectsTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { ExportTab } from "./tabs/ExportTab";
import { FutureAiTab } from "./tabs/FutureAiTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";

export type WorkspaceTab = "home" | "edit" | "audio" | "color" | "effects" | "shortcuts" | "plugins" | "export" | "future-ai";

const maxAppLogEntries = 1000;
const autosaveDelayMs = 4500;
const maxCommandHistoryEntries = 80;

const workspaceTabs: TabItem<WorkspaceTab>[] = [
  { id: "home", label: "Home", icon: <Home size={16} /> },
  { id: "edit", label: "Edit", icon: <Clapperboard size={16} /> },
  { id: "audio", label: "Audio", icon: <AudioLines size={16} /> },
  { id: "color", label: "Color", icon: <Palette size={16} /> },
  { id: "effects", label: "Effects", icon: <WandSparkles size={16} /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Keyboard size={16} /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle size={16} /> },
  { id: "export", label: "Export", icon: <Download size={16} /> },
  { id: "future-ai", label: "Future AI", icon: <Bot size={16} /> }
];

interface ProjectSettingsChange {
  label: string;
  from: string;
  to: string;
}

interface ProjectSettingsProposal {
  assetName: string;
  metadata: MediaMetadata;
  nextSettings: ProjectSettings;
  changes: ProjectSettingsChange[];
}

export function AppShell() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("edit");
  const [project, setProject] = useState<ActiveProject>({ name: "Untitled Project" });
  const [recentProjects, setRecentProjects] = useState<ActiveProject[]>([]);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [timeline, setTimeline] = useState<Timeline>(starterTimeline);
  const [aiProposals, setAiProposals] = useState<AiEditProposal[]>([]);
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(defaultProjectSettings);
  const [settingsProposal, setSettingsProposal] = useState<ProjectSettingsProposal | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [projectDirty, setProjectDirty] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [autosaveState, setAutosaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [missingMediaPaths, setMissingMediaPaths] = useState<string[]>([]);
  const [undoStack, setUndoStack] = useState<ProjectSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<ProjectSnapshot[]>([]);
  const [statusMessage, setLatestStatusMessage] = useState("Ready");
  const [appLogs, setAppLogs] = useState<AppLogEntry[]>(() => [createAppLogEntry("Ready", { source: "app" })]);
  const projectRef = useRef(project);
  const logPersistenceWarningShownRef = useRef(false);
  const lastSavedStateRef = useRef(serializeProjectState(defaultProjectSettings, [], starterTimeline, []));
  const historyStateRef = useRef(serializeProjectState(defaultProjectSettings, [], starterTimeline, []));
  const lastHistorySnapshotRef = useRef<ProjectSnapshot | null>(null);
  const loadingProjectRef = useRef(false);
  const applyingHistoryRef = useRef(false);
  const lastMissingMediaKeyRef = useRef("");

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    if (loadingProjectRef.current) {
      return;
    }

    const stateHash = serializeProjectState(projectSettings, mediaAssets, timeline, aiProposals);
    setProjectDirty(Boolean(lastSavedStateRef.current) && stateHash !== lastSavedStateRef.current);
  }, [aiProposals, mediaAssets, projectSettings, timeline]);

  useEffect(() => {
    if (loadingProjectRef.current || applyingHistoryRef.current) {
      return;
    }

    const stateHash = serializeProjectState(projectSettings, mediaAssets, timeline, aiProposals);
    const previousSnapshot = lastHistorySnapshotRef.current;
    if (!previousSnapshot) {
      historyStateRef.current = stateHash;
      lastHistorySnapshotRef.current = createHistorySnapshot();
      return;
    }

    if (stateHash === historyStateRef.current) {
      return;
    }

    setUndoStack((current) => [...current, previousSnapshot].slice(-maxCommandHistoryEntries));
    setRedoStack([]);
    historyStateRef.current = stateHash;
    lastHistorySnapshotRef.current = createHistorySnapshot();
  }, [aiProposals, mediaAssets, projectSettings, timeline]);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!projectDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [projectDirty]);

  useEffect(() => {
    if (!projectDirty || savingProject) {
      return;
    }

    setAutosaveState("pending");
    const timeout = window.setTimeout(() => {
      void saveProject("autosave");
    }, autosaveDelayMs);

    return () => window.clearTimeout(timeout);
  }, [aiProposals, mediaAssets, projectDirty, projectSettings, savingProject, timeline]);

  useEffect(() => {
    let cancelled = false;
    const paths = mediaAssets.map((asset) => asset.path).filter(Boolean);
    if (paths.length === 0) {
      setMissingMediaPaths([]);
      lastMissingMediaKeyRef.current = "";
      return;
    }

    const timeout = window.setTimeout(() => {
      void validateMediaPaths(paths)
        .then((missing) => {
          if (cancelled) {
            return;
          }
          setMissingMediaPaths(missing);
          const key = missing.slice().sort().join("|");
          if (missing.length > 0 && key !== lastMissingMediaKeyRef.current) {
            lastMissingMediaKeyRef.current = key;
            logStatus(`${missing.length} missing media file${missing.length === 1 ? "" : "s"} detected`, {
              level: "warning",
              source: "media",
              details: { missing }
            });
          } else if (missing.length === 0 && lastMissingMediaKeyRef.current) {
            lastMissingMediaKeyRef.current = "";
            recordLog("Missing media check passed", { source: "media" }, false);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            logStatus(error instanceof Error ? error.message : "Media path validation failed", { level: "error", source: "media" });
          }
        });
    }, 800);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [mediaAssets]);

  useEffect(() => {
    setRecentProjects(loadRecentProjects());

    getEngineStatus()
      .then((status) => {
        setEngineStatus(status);
        logStatus("Engine status refreshed", {
          source: "engine",
          details: {
            ffmpeg: status.ffmpeg.available,
            ffprobe: status.ffprobe.available,
            gpu: status.gpu.name ?? status.gpu.message ?? "unknown"
          }
        });
        void refreshEngineState("startup");
      })
      .catch((error) => {
        logStatus(error instanceof Error ? error.message : "Engine status failed", { level: "error", source: "engine" });
      });
  }, []);

  useEffect(() => {
    function onCommandExecution(event: Event) {
      const detail = (event as CustomEvent<CommandExecutionEventDetail>).detail;
      if (!detail?.commandType) {
        return;
      }

      if (detail.phase === "start") {
        recordLog(`Command started: ${formatCommandType(detail.commandType)}`, {
          level: "debug",
          source: commandSource(detail.commandType),
          details: { command: detail.command }
        }, false);
        return;
      }

      if (detail.phase === "finish" && detail.ok) {
        recordLog(`Command accepted: ${formatCommandType(detail.commandType)}`, {
          source: commandSource(detail.commandType),
          details: { commandId: detail.commandId, durationMs: detail.durationMs, command: detail.command }
        }, false);
        return;
      }

      logStatus(detail.error ?? `Command failed: ${formatCommandType(detail.commandType)}`, {
        level: "error",
        source: commandSource(detail.commandType),
        details: { commandId: detail.commandId, durationMs: detail.durationMs, command: detail.command }
      });
    }

    function onWindowError(event: ErrorEvent) {
      logStatus(event.message || "Unhandled app error", {
        level: "error",
        source: "app",
        details: {
          filename: event.filename,
          line: event.lineno,
          column: event.colno,
          stack: event.error instanceof Error ? event.error.stack : undefined
        }
      });
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason;
      logStatus(reason instanceof Error ? reason.message : "Unhandled promise rejection", {
        level: "error",
        source: "app",
        details: {
          stack: reason instanceof Error ? reason.stack : undefined,
          reason: reason instanceof Error ? reason.name : reason
        }
      });
    }

    window.addEventListener("ai-video-editor:command-execution", onCommandExecution);
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("ai-video-editor:command-execution", onCommandExecution);
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [aiProposals, autosaveState, mediaAssets, projectSettings, savingProject, timeline]);

  useEffect(() => {
    async function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        recordLog("Command search opened", { source: "ui" }, false);
      }

      if (event.ctrlKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        openWorkspaceTab("export");
      }

      if (event.ctrlKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        await handleImportMedia();
      }

      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        await saveProject("manual");
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        redoProjectState();
      } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoProjectState();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function applyProject(nextProject: ActiveProject) {
    loadingProjectRef.current = true;
    const openedProject = { ...nextProject, lastOpenedAt: new Date().toISOString() };
    setProject(openedProject);
    setRecentProjects(saveRecentProject(openedProject));
    setSettingsProposal(null);
    setMissingMediaPaths([]);
    setAutosaveState("idle");
    logPersistenceWarningShownRef.current = false;
    projectRef.current = openedProject;

    try {
      const snapshot = await loadProjectSnapshot(openedProject);
      if (snapshot) {
        restoreProjectSnapshot(snapshot, openedProject);
        logStatus(`Project restored: ${openedProject.name}`, {
          level: "success",
          source: "project",
          details: { path: openedProject.path, savedAt: snapshot.savedAt, mediaCount: snapshot.mediaAssets.length }
        });
      } else {
        const savedAt = new Date().toISOString();
        const blankProject = { ...openedProject, lastSavedAt: savedAt };
        projectRef.current = blankProject;
        setProject(blankProject);
        setRecentProjects(saveRecentProject(blankProject));
        setMediaAssets([]);
        setTimeline(starterTimeline);
        setAiProposals([]);
        setProjectSettings(defaultProjectSettings);
        const blankHash = serializeProjectState(defaultProjectSettings, [], starterTimeline, []);
        lastSavedStateRef.current = blankHash;
        resetCommandHistory(blankProject, defaultProjectSettings, [], starterTimeline, []);
        setLastSavedAt(savedAt);
        setProjectDirty(false);
        const blankSnapshot: ProjectSnapshot = {
          version: 1,
          savedAt,
          project: blankProject,
          projectSettings: defaultProjectSettings,
          mediaAssets: [],
          timeline: starterTimeline,
          aiProposals: []
        };
        void saveProjectSnapshot(blankProject, blankSnapshot).catch((error) => {
          logStatus(error instanceof Error ? error.message : "Initial project snapshot save failed", { level: "error", source: "project" });
        });
        logStatus(`Project open: ${openedProject.name}`, {
          source: "project",
          details: { path: openedProject.path, manifestPath: openedProject.manifestPath, restored: false }
        });
      }
      openWorkspaceTab("edit");
    } catch (error) {
      setMediaAssets([]);
      setTimeline(starterTimeline);
      setAiProposals([]);
      setProjectSettings(defaultProjectSettings);
      lastSavedStateRef.current = serializeProjectState(defaultProjectSettings, [], starterTimeline, []);
      resetCommandHistory(openedProject, defaultProjectSettings, [], starterTimeline, []);
      setProjectDirty(false);
      logStatus(error instanceof Error ? error.message : "Project restore failed", { level: "error", source: "project", details: { project: openedProject } });
    } finally {
      window.setTimeout(() => {
        loadingProjectRef.current = false;
      }, 0);
    }
  }

  function applyImportedMedia(result: ImportMediaResult | null) {
    if (!result) {
      logStatus("No supported media selected", { level: "warning", source: "media" });
      return;
    }

    if (!result.command.ok) {
      logStatus(result.command.error ?? "Import failed", { level: "error", source: "media" });
      return;
    }

    setMediaAssets((existing) => {
      const existingPaths = new Set(existing.map((asset) => asset.path));
      const newAssets = result.media.filter((asset) => !existingPaths.has(asset.path));
      return [...existing, ...newAssets];
    });
    applyTimelineFromCommandData(result.command.data);
    const importedVideo = result.media.find((asset) => asset.kind === "video" && asset.metadata);
    if (importedVideo?.metadata) {
      const proposal = createProjectSettingsProposal(importedVideo, projectSettings);
      if (proposal.changes.length > 0) {
        setSettingsProposal(proposal);
      }
    }
    logStatus(`Imported ${result.media.length} media file${result.media.length === 1 ? "" : "s"}`, {
      level: "success",
      source: "media",
      details: { paths: result.media.map((asset) => asset.path) }
    });
    openWorkspaceTab("edit");
  }

  function applySettingsProposal() {
    if (!settingsProposal) {
      return;
    }

    setProjectSettings(settingsProposal.nextSettings);
    setSettingsProposal(null);
    logStatus(`Project settings updated from ${settingsProposal.assetName}`, {
      source: "project",
      details: { changes: settingsProposal.changes }
    });
  }

  async function handleImportMedia() {
    try {
      logStatus("Import media requested", { source: "media" });
      applyImportedMedia(await importMediaFiles());
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "Import failed", { level: "error", source: "media" });
    }
  }

  function removeMediaAsset(assetId: string, data?: unknown) {
    const resultData = data as { mediaIndex?: { media?: MediaAsset[] }; timeline?: Timeline } | undefined;
    if (Array.isArray(resultData?.mediaIndex?.media)) {
      setMediaAssets(resultData.mediaIndex.media);
    } else {
      setMediaAssets((existing) => existing.filter((asset) => asset.id !== assetId));
    }

    if (resultData?.timeline?.tracks) {
      setTimeline(resultData.timeline);
    } else {
      setTimeline((current) => ({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => clip.mediaId !== assetId)
        }))
      }));
    }
  }

  function renameMediaAsset(assetId: string, nextName: string) {
    const trimmedName = nextName.trim();
    if (!trimmedName) {
      logStatus("Media rename requires a name", { level: "warning", source: "media", details: { mediaId: assetId } });
      return;
    }

    const previousName = mediaAssets.find((asset) => asset.id === assetId)?.name ?? "";
    setMediaAssets((existing) =>
      existing.map((asset) => {
        if (asset.id !== assetId) {
          return asset;
        }
        return { ...asset, name: trimmedName };
      })
    );
    logStatus(`Renamed media bin item to ${trimmedName}`, {
      source: "media",
      details: { mediaId: assetId, previousName, nextName: trimmedName }
    });
  }

  function relinkMediaAsset(assetId: string, relinkedAsset: MediaAsset) {
    const previousAsset = mediaAssets.find((asset) => asset.id === assetId);
    const previousPath = previousAsset?.path ?? "";
    setMediaAssets((existing) =>
      existing.map((asset) => {
        if (asset.id !== assetId) {
          return asset;
        }
        return { ...relinkedAsset, id: asset.id, name: asset.name };
      })
    );
    setMissingMediaPaths((existing) => existing.filter((path) => path !== previousPath && path !== relinkedAsset.path));
    logStatus(`Relinked media: ${previousAsset?.name ?? relinkedAsset.name}`, {
      level: "success",
      source: "media",
      details: { mediaId: assetId, previousPath, nextPath: relinkedAsset.path, metadata: relinkedAsset.metadata ?? null }
    });
  }

  async function refreshEngineState(reason = "manual") {
    try {
      const [mediaIndex, nextTimeline, proposalIndex] = await Promise.all([
        engineRpc<{ media: MediaAsset[] }>("media.index"),
        engineRpc<Timeline>("timeline.state"),
        engineRpc<{ proposals: AiEditProposal[] }>("ai.proposals")
      ]);
      setMediaAssets(mediaIndex.media ?? []);
      setTimeline(nextTimeline);
      setAiProposals(proposalIndex.proposals ?? []);
      recordLog("Engine state refreshed", {
        source: "engine",
        details: {
          reason,
          mediaCount: mediaIndex.media?.length ?? 0,
          trackCount: nextTimeline.tracks.length,
          proposalCount: proposalIndex.proposals?.length ?? 0
        }
      }, false);
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "Engine state refresh failed", { level: "error", source: "engine", details: { reason } });
    }
  }

  function applyTimelineFromCommandData(data: unknown) {
    const maybeTimeline = (data as { timeline?: Timeline } | undefined)?.timeline;
    if (maybeTimeline?.tracks) {
      setTimeline(maybeTimeline);
    }
  }

  async function generateRoughCutProposal(goal: string, mediaIds: string[]) {
    try {
      recordLog("Rough cut proposal requested", { source: "ai", details: { goal, mediaIds } }, false);
      const proposal = await engineRpc<AiEditProposal>("ai.proposal.generate", { goal, mediaIds });
      setAiProposals((current) => [proposal, ...current.filter((item) => item.id !== proposal.id)]);
      logStatus("Rough cut proposal generated", { level: "success", source: "ai", details: { goal, mediaIds, proposalId: proposal.id } });
      openWorkspaceTab("future-ai");
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "Rough cut proposal failed", { level: "error", source: "ai", details: { goal, mediaIds } });
    }
  }

  async function applyAiProposal(proposalId: string) {
    try {
      recordLog("AI proposal apply requested", { source: "ai", details: { proposalId } }, false);
      await engineRpc<AiEditProposal>("ai.proposal.apply", { proposalId });
      await refreshEngineState("ai proposal applied");
      logStatus("AI proposal applied to timeline", { level: "success", source: "ai", details: { proposalId } });
      openWorkspaceTab("edit");
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "AI proposal apply failed", { level: "error", source: "ai", details: { proposalId } });
    }
  }

  async function rejectAiProposal(proposalId: string) {
    try {
      const proposal = await engineRpc<AiEditProposal>("ai.proposal.reject", { proposalId });
      setAiProposals((current) => current.map((item) => (item.id === proposal.id ? proposal : item)));
      logStatus("AI proposal rejected", { source: "ai", details: { proposalId } });
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "AI proposal reject failed", { level: "error", source: "ai", details: { proposalId } });
    }
  }

  function appendLogEntry(entry: AppLogEntry, updateStatus = true) {
    if (updateStatus) {
      setLatestStatusMessage(entry.message);
    }
    setAppLogs((current) => [...current, entry].slice(-maxAppLogEntries));
  }

  function logStatus(message: string, options: LogStatusOptions = {}) {
    recordLog(message, options);
  }

  function recordLog(message: string, options: LogStatusOptions = {}, updateStatus = true) {
    const entry = createAppLogEntry(message, options);
    appendLogEntry(entry, updateStatus);

    void appendProjectLog(entry, projectRef.current.path).catch((error) => {
      if (logPersistenceWarningShownRef.current) {
        return;
      }
      logPersistenceWarningShownRef.current = true;
      appendLogEntry(
        createAppLogEntry(error instanceof Error ? error.message : "Project log file persistence failed", {
          level: "warning",
          source: "app"
        }),
        false
      );
    });
  }

  function makeStatusLogger(source: AppLogSource) {
    return (message: string, options?: LogStatusOptions) => logStatus(message, { source, ...options });
  }

  async function saveProject(reason: "manual" | "autosave") {
    const activeProject = projectRef.current;
    const savedAt = new Date().toISOString();
    const snapshot = createProjectSnapshot({ ...activeProject, lastSavedAt: savedAt }, savedAt);

    setSavingProject(true);
    setAutosaveState(reason === "autosave" ? "saving" : autosaveState);
    if (reason === "manual") {
      logStatus("Save requested", { source: "project", details: { project: activeProject.name, projectPath: activeProject.path ?? null } });
    }

    try {
      await saveProjectSnapshot(activeProject, snapshot);
      const savedProject = { ...activeProject, lastSavedAt: savedAt };
      projectRef.current = savedProject;
      setProject(savedProject);
      setRecentProjects(saveRecentProject(savedProject));
      lastSavedStateRef.current = serializeProjectState(projectSettings, mediaAssets, timeline, aiProposals);
      setProjectDirty(false);
      setLastSavedAt(savedAt);
      setAutosaveState(reason === "autosave" ? "saved" : "idle");
      logStatus(reason === "autosave" ? "Project autosaved" : "Project saved", {
        level: "success",
        source: "project",
        details: { projectPath: activeProject.path ?? null, savedAt }
      });
    } catch (error) {
      setAutosaveState("error");
      logStatus(error instanceof Error ? error.message : "Project save failed", {
        level: "error",
        source: "project",
        details: { reason, projectPath: activeProject.path ?? null }
      });
    } finally {
      setSavingProject(false);
    }
  }

  function createProjectSnapshot(snapshotProject: ActiveProject, savedAt: string): ProjectSnapshot {
    return {
      version: 1,
      savedAt,
      project: snapshotProject,
      projectSettings,
      mediaAssets,
      timeline,
      aiProposals
    };
  }

  function restoreProjectSnapshot(snapshot: ProjectSnapshot, fallbackProject: ActiveProject) {
    const restoredProject = {
      ...fallbackProject,
      name: snapshot.project.name || fallbackProject.name,
      lastSavedAt: snapshot.savedAt
    };
    projectRef.current = restoredProject;
    setProject(restoredProject);
    setRecentProjects(saveRecentProject(restoredProject));
    setMediaAssets(snapshot.mediaAssets ?? []);
    setTimeline(snapshot.timeline ?? starterTimeline);
    setAiProposals(snapshot.aiProposals ?? []);
    const restoredSettings = { ...defaultProjectSettings, ...(snapshot.projectSettings ?? {}) };
    setProjectSettings(restoredSettings);
    lastSavedStateRef.current = serializeProjectState(
      restoredSettings,
      snapshot.mediaAssets ?? [],
      snapshot.timeline ?? starterTimeline,
      snapshot.aiProposals ?? []
    );
    resetCommandHistory(
      restoredProject,
      restoredSettings,
      snapshot.mediaAssets ?? [],
      snapshot.timeline ?? starterTimeline,
      snapshot.aiProposals ?? []
    );
    setLastSavedAt(snapshot.savedAt);
    setProjectDirty(false);
    setAutosaveState("idle");
  }

  function createHistorySnapshot(): ProjectSnapshot {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      project: projectRef.current,
      projectSettings,
      mediaAssets,
      timeline,
      aiProposals
    };
  }

  function resetCommandHistory(
    nextProject: ActiveProject,
    nextSettings: ProjectSettings,
    nextMediaAssets: MediaAsset[],
    nextTimeline: Timeline,
    nextProposals: AiEditProposal[]
  ) {
    const stateHash = serializeProjectState(nextSettings, nextMediaAssets, nextTimeline, nextProposals);
    historyStateRef.current = stateHash;
    lastHistorySnapshotRef.current = {
      version: 1,
      savedAt: new Date().toISOString(),
      project: nextProject,
      projectSettings: nextSettings,
      mediaAssets: nextMediaAssets,
      timeline: nextTimeline,
      aiProposals: nextProposals
    };
    setUndoStack([]);
    setRedoStack([]);
  }

  function restoreHistorySnapshot(snapshot: ProjectSnapshot) {
    applyingHistoryRef.current = true;
    const restoredSettings = { ...defaultProjectSettings, ...(snapshot.projectSettings ?? {}) };
    setProjectSettings(restoredSettings);
    setMediaAssets(snapshot.mediaAssets ?? []);
    setTimeline(snapshot.timeline ?? starterTimeline);
    setAiProposals(snapshot.aiProposals ?? []);
    const stateHash = serializeProjectState(
      restoredSettings,
      snapshot.mediaAssets ?? [],
      snapshot.timeline ?? starterTimeline,
      snapshot.aiProposals ?? []
    );
    historyStateRef.current = stateHash;
    lastHistorySnapshotRef.current = {
      ...snapshot,
      project: projectRef.current,
      savedAt: new Date().toISOString()
    };
    window.setTimeout(() => {
      applyingHistoryRef.current = false;
    }, 0);
  }

  function undoProjectState() {
    const previous = undoStack.at(-1);
    if (!previous) {
      logStatus("Nothing to undo", { level: "warning", source: "timeline" });
      return;
    }

    const currentSnapshot = createHistorySnapshot();
    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) => [...current, currentSnapshot].slice(-maxCommandHistoryEntries));
    restoreHistorySnapshot(previous);
    setProjectDirty(true);
    logStatus("Undo restored previous edit state", {
      level: "success",
      source: "timeline",
      details: { undoCount: Math.max(0, undoStack.length - 1), redoCount: redoStack.length + 1 }
    });
  }

  function redoProjectState() {
    const next = redoStack.at(-1);
    if (!next) {
      logStatus("Nothing to redo", { level: "warning", source: "timeline" });
      return;
    }

    const currentSnapshot = createHistorySnapshot();
    setRedoStack((current) => current.slice(0, -1));
    setUndoStack((current) => [...current, currentSnapshot].slice(-maxCommandHistoryEntries));
    restoreHistorySnapshot(next);
    setProjectDirty(true);
    logStatus("Redo restored next edit state", {
      level: "success",
      source: "timeline",
      details: { undoCount: undoStack.length + 1, redoCount: Math.max(0, redoStack.length - 1) }
    });
  }

  function openWorkspaceTab(nextTab: WorkspaceTab) {
    setActiveTab(nextTab);
    recordLog(`Opened ${workspaceTabs.find((tab) => tab.id === nextTab)?.label ?? nextTab} workspace`, { source: "ui", details: { tab: nextTab } }, false);
  }

  async function copyLogs() {
    const text = logsToText(appLogs);
    try {
      await navigator.clipboard.writeText(text);
      logStatus("Copied visible logs to clipboard", { level: "success", source: "app" });
    } catch (error) {
      logStatus(error instanceof Error ? error.message : "Copy logs failed", { level: "error", source: "app" });
    }
  }

  function exportLogs() {
    const jsonl = appLogs.map((entry) => JSON.stringify(entry)).join("\n");
    const blob = new Blob([`${jsonl}\n`], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ai-video-editor-logs-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    logStatus("Exported visible logs", { level: "success", source: "app" });
  }

  function clearLogs() {
    const entry = createAppLogEntry("Logs cleared", { source: "app" });
    setLatestStatusMessage(entry.message);
    setAppLogs([entry]);
    void appendProjectLog(entry, projectRef.current.path).catch(() => undefined);
  }

  const activeContent = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeTab engineStatus={engineStatus} recentProjects={recentProjects} onProjectOpen={applyProject} setStatusMessage={makeStatusLogger("project")} />;
      case "edit":
        return (
          <EditTab
            previewUrl={engineStatus?.previewUrl}
            mediaAssets={mediaAssets}
            timeline={timeline}
            setTimeline={(nextTimeline) => {
              setTimeline(nextTimeline);
            }}
            projectSettings={projectSettings}
            onImportMedia={handleImportMedia}
            onImportMediaResult={applyImportedMedia}
            onRemoveMediaAsset={removeMediaAsset}
            onRenameMediaAsset={renameMediaAsset}
            onRelinkMediaAsset={relinkMediaAsset}
            missingMediaPaths={missingMediaPaths}
            projectPath={project.path}
            setStatusMessage={makeStatusLogger("timeline")}
          />
        );
      case "audio":
        return (
          <AudioTab
            timeline={timeline}
            setTimeline={setTimeline}
            mediaAssets={mediaAssets}
            projectSettings={projectSettings}
            onProjectSettingsChange={(settings) => {
              setProjectSettings(settings);
              logStatus("Project audio settings changed", { source: "project", details: { settings } });
            }}
            setStatusMessage={makeStatusLogger("audio")}
          />
        );
      case "color":
        return <ColorTab />;
      case "effects":
        return <EffectsTab />;
      case "shortcuts":
        return <ShortcutsTab />;
      case "plugins":
        return <PluginsTab />;
      case "export":
        return (
          <ExportTab
            projectSettings={projectSettings}
            onProjectSettingsChange={(settings) => {
              setProjectSettings(settings);
              logStatus("Project settings changed", { source: "project", details: { settings } });
            }}
            firstMediaMetadata={mediaAssets.find((asset) => asset.kind === "video" && asset.metadata)?.metadata}
            mediaAssets={mediaAssets}
            timeline={timeline}
            timelineDurationUs={timeline.durationUs}
            gpuStatus={engineStatus?.gpu ?? null}
            setStatusMessage={makeStatusLogger("export")}
          />
        );
      case "future-ai":
        return (
          <FutureAiTab
            mediaAssets={mediaAssets}
            proposals={aiProposals}
            onGenerateProposal={generateRoughCutProposal}
            onApplyProposal={applyAiProposal}
            onRejectProposal={rejectAiProposal}
          />
        );
      default:
        return null;
    }
  }, [activeTab, aiProposals, engineStatus, mediaAssets, missingMediaPaths, project.path, projectSettings, recentProjects, timeline]);

  return (
    <main className="app-shell">
      <TopBar
        projectName={`${project.name}${projectDirty ? " *" : ""}`}
        onImportMedia={handleImportMedia}
        onSave={() => void saveProject("manual")}
        onUndo={undoProjectState}
        onRedo={redoProjectState}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        onOpenCommandPalette={() => {
          setCommandPaletteOpen(true);
          recordLog("Command search opened", { source: "ui" }, false);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          recordLog("Settings opened", { source: "ui" }, false);
        }}
        onExport={() => openWorkspaceTab("export")}
      />
      <Tabs items={workspaceTabs} activeId={activeTab} onChange={openWorkspaceTab} />
      <section className="workspace">{activeContent}</section>
      <footer className="status-bar">
        <button type="button" className="status-message-button" onClick={() => setLogsOpen(true)} title="Open application logs">
          <span>{statusMessage}</span>
        </button>
        <span className="status-pill">
          {projectStatusLabel(projectDirty, savingProject, autosaveState, lastSavedAt)}
        </span>
        <span className="status-pill">
          Undo {undoStack.length} / Redo {redoStack.length}
        </span>
        {missingMediaPaths.length > 0 ? (
          <span className="status-pill status-pill-warning">
            {missingMediaPaths.length} missing media
          </span>
        ) : null}
        <span className="status-pill">
          <Blocks size={14} />
          {engineStatus?.gpu.name ?? "GPU unknown"}
        </span>
      </footer>

      <LogsDrawer open={logsOpen} logs={appLogs} onClose={() => setLogsOpen(false)} onClear={clearLogs} onCopy={copyLogs} onExport={exportLogs} />

      <Modal title="Command Search" open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)}>
        <div className="command-palette">
          {shortcutDefinitions.map((shortcut) => (
            <button key={shortcut.id} type="button" onClick={() => setCommandPaletteOpen(false)}>
              <span>{shortcut.command}</span>
              <kbd>{shortcut.keys}</kbd>
            </button>
          ))}
        </div>
      </Modal>

      <Modal title="Settings" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
        <div className="settings-grid">
          <div>
            <strong>Media import</strong>
            <span>Link original files by default.</span>
          </div>
          <div>
            <strong>Preview</strong>
            <span>Use proxy playback when needed.</span>
          </div>
          <div>
            <strong>Plugins</strong>
            <span>C++ plugins require developer mode.</span>
          </div>
          <div>
            <strong>Future AI</strong>
            <span>AI changes require approval by default.</span>
          </div>
        </div>
      </Modal>

      <Modal title="Update Project Settings" open={Boolean(settingsProposal)} onClose={() => setSettingsProposal(null)}>
        {settingsProposal ? (
          <div className="project-settings-proposal">
            <div className="proposal-source">
              <strong>{settingsProposal.assetName}</strong>
              <span>
                {settingsProposal.metadata.width}x{settingsProposal.metadata.height} · {formatFps(settingsProposal.metadata.fps)} fps ·{" "}
                {settingsProposal.metadata.hdr ? "HDR" : "SDR"}
              </span>
            </div>
            <div className="settings-change-list">
              {settingsProposal.changes.map((change) => (
                <div key={change.label} className="settings-change-row">
                  <span>{change.label}</span>
                  <small>{change.from}</small>
                  <strong>{change.to}</strong>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <Button onClick={() => setSettingsProposal(null)}>Keep Current</Button>
              <Button variant="primary" onClick={applySettingsProposal}>
                Apply Changes
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}

function createProjectSettingsProposal(asset: MediaAsset, current: ProjectSettings): ProjectSettingsProposal {
  const nextSettings = seedProjectSettingsFromMetadata(asset.metadata as MediaMetadata);
  const changes = getProjectSettingsChanges(current, nextSettings);
  return {
    assetName: asset.name,
    metadata: asset.metadata as MediaMetadata,
    nextSettings,
    changes
  };
}

function getProjectSettingsChanges(current: ProjectSettings, next: ProjectSettings): ProjectSettingsChange[] {
  const rows: Array<[string, string, string]> = [
    ["Resolution mode", formatResolution(current), formatResolution(next)],
    ["Width", `${current.width}px`, `${next.width}px`],
    ["Height", `${current.height}px`, `${next.height}px`],
    ["FPS", `${current.fps}`, `${next.fps}`],
    ["Color", current.colorMode, next.colorMode],
    ["Default codec", formatCodec(current.defaultCodec), formatCodec(next.defaultCodec)],
    ["Default file type", current.defaultContainer.toUpperCase(), next.defaultContainer.toUpperCase()],
    ["Audio", current.audioEnabled ? "Enabled" : "Disabled", next.audioEnabled ? "Enabled" : "Disabled"],
    ["Master gain", `${current.masterGainDb ?? 0} dB`, `${next.masterGainDb ?? 0} dB`],
    ["Normalize audio", current.normalizeAudio ? "Enabled" : "Disabled", next.normalizeAudio ? "Enabled" : "Disabled"],
    ["Audio cleanup", current.cleanupAudio ? "Enabled" : "Disabled", next.cleanupAudio ? "Enabled" : "Disabled"],
    ["Medium bitrate", `${current.bitrateMbps} Mbps`, `${next.bitrateMbps} Mbps`]
  ];

  return rows
    .filter(([, from, to]) => from !== to)
    .map(([label, from, to]) => ({
      label,
      from,
      to
    }));
}

function formatResolution(settings: ProjectSettings) {
  if (settings.resolution === "source") {
    return `Source (${settings.width}x${settings.height})`;
  }
  if (settings.resolution === "custom") {
    return `Custom (${settings.width}x${settings.height})`;
  }
  return `${settings.resolution} (${settings.width}x${settings.height})`;
}

function formatCodec(codec: ProjectSettings["defaultCodec"]) {
  if (codec === "hevc_nvenc") {
    return "H.265 NVENC";
  }
  if (codec === "av1_nvenc") {
    return "AV1 NVENC";
  }
  return "H.264 NVENC";
}

function formatFps(fps: number) {
  return Number.isFinite(fps) && fps > 0 ? fps.toFixed(Math.abs(fps - Math.round(fps)) < 0.01 ? 0 : 3) : "unknown";
}

function commandSource(commandType: string): AppLogSource {
  if (commandType.includes("media")) {
    return "media";
  }
  if (commandType.includes("audio")) {
    return "audio";
  }
  if (commandType.includes("color") || commandType.includes("lut")) {
    return "timeline";
  }
  if (commandType.includes("export")) {
    return "export";
  }
  return "timeline";
}

function formatCommandType(commandType: string) {
  return commandType.replaceAll("_", " ");
}

function serializeProjectState(projectSettings: ProjectSettings, mediaAssets: MediaAsset[], timeline: Timeline, aiProposals: AiEditProposal[]) {
  return JSON.stringify({
    projectSettings,
    mediaAssets,
    timeline,
    aiProposals
  });
}

function projectStatusLabel(dirty: boolean, saving: boolean, autosaveState: string, lastSavedAt: string | null) {
  if (saving || autosaveState === "saving") {
    return "Saving";
  }
  if (autosaveState === "pending") {
    return "Autosave pending";
  }
  if (autosaveState === "error") {
    return "Save failed";
  }
  if (dirty) {
    return "Unsaved";
  }
  if (lastSavedAt) {
    return `Saved ${formatShortTime(lastSavedAt)}`;
  }
  return "Not saved";
}

function formatShortTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
