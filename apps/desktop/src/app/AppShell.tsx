import { useEffect, useMemo, useState } from "react";
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
import { engineRpc, getEngineStatus } from "../features/commands/commandClient";
import { isTypingTarget, shortcutDefinitions } from "../features/commands/shortcuts";
import { importMediaFiles, type ImportMediaResult } from "../features/media/importMedia";
import type { MediaAsset } from "../features/media/mediaTypes";
import { loadRecentProjects, saveRecentProject, type ActiveProject } from "../features/projects/projectActions";
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
  const [statusMessage, setStatusMessage] = useState("Ready");

  useEffect(() => {
    setRecentProjects(loadRecentProjects());

    getEngineStatus()
      .then((status) => {
        setEngineStatus(status);
        void refreshEngineState();
      })
      .catch((error) => {
        setStatusMessage(error instanceof Error ? error.message : "Engine status failed");
      });
  }, []);

  useEffect(() => {
    async function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (event.ctrlKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setActiveTab("export");
      }

      if (event.ctrlKey && event.key.toLowerCase() === "i") {
        event.preventDefault();
        await handleImportMedia();
      }

      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setStatusMessage("Save command queued");
      }

      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setStatusMessage("Redo command queued");
      } else if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setStatusMessage("Undo command queued");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function applyProject(nextProject: ActiveProject) {
    setProject(nextProject);
    setRecentProjects(saveRecentProject(nextProject));
    setMediaAssets([]);
    setTimeline(starterTimeline);
    setAiProposals([]);
    setProjectSettings(defaultProjectSettings);
    setSettingsProposal(null);
    setStatusMessage(`Project open: ${nextProject.name}`);
    setActiveTab("edit");
  }

  function applyImportedMedia(result: ImportMediaResult | null) {
    if (!result) {
      setStatusMessage("No supported media selected");
      return;
    }

    if (!result.command.ok) {
      setStatusMessage(result.command.error ?? "Import failed");
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
    setStatusMessage(`Imported ${result.media.length} media file${result.media.length === 1 ? "" : "s"}`);
    setActiveTab("edit");
  }

  function applySettingsProposal() {
    if (!settingsProposal) {
      return;
    }

    setProjectSettings(settingsProposal.nextSettings);
    setSettingsProposal(null);
    setStatusMessage(`Project settings updated from ${settingsProposal.assetName}`);
  }

  async function handleImportMedia() {
    applyImportedMedia(await importMediaFiles());
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

  async function refreshEngineState() {
    const [mediaIndex, nextTimeline, proposalIndex] = await Promise.all([
      engineRpc<{ media: MediaAsset[] }>("media.index"),
      engineRpc<Timeline>("timeline.state"),
      engineRpc<{ proposals: AiEditProposal[] }>("ai.proposals")
    ]);
    setMediaAssets(mediaIndex.media ?? []);
    setTimeline(nextTimeline);
    setAiProposals(proposalIndex.proposals ?? []);
  }

  function applyTimelineFromCommandData(data: unknown) {
    const maybeTimeline = (data as { timeline?: Timeline } | undefined)?.timeline;
    if (maybeTimeline?.tracks) {
      setTimeline(maybeTimeline);
    }
  }

  async function generateRoughCutProposal(goal: string, mediaIds: string[]) {
    const proposal = await engineRpc<AiEditProposal>("ai.proposal.generate", { goal, mediaIds });
    setAiProposals((current) => [proposal, ...current.filter((item) => item.id !== proposal.id)]);
    setStatusMessage("Rough cut proposal generated");
    setActiveTab("future-ai");
  }

  async function applyAiProposal(proposalId: string) {
    await engineRpc<AiEditProposal>("ai.proposal.apply", { proposalId });
    await refreshEngineState();
    setStatusMessage("AI proposal applied to timeline");
    setActiveTab("edit");
  }

  async function rejectAiProposal(proposalId: string) {
    const proposal = await engineRpc<AiEditProposal>("ai.proposal.reject", { proposalId });
    setAiProposals((current) => current.map((item) => (item.id === proposal.id ? proposal : item)));
    setStatusMessage("AI proposal rejected");
  }

  const activeContent = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeTab engineStatus={engineStatus} recentProjects={recentProjects} onProjectOpen={applyProject} setStatusMessage={setStatusMessage} />;
      case "edit":
        return (
          <EditTab
            previewUrl={engineStatus?.previewUrl}
            mediaAssets={mediaAssets}
            timeline={timeline}
            setTimeline={setTimeline}
            projectSettings={projectSettings}
            onImportMedia={handleImportMedia}
            onImportMediaResult={applyImportedMedia}
            onRemoveMediaAsset={removeMediaAsset}
            setStatusMessage={setStatusMessage}
          />
        );
      case "audio":
        return <AudioTab />;
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
            }}
            firstMediaMetadata={mediaAssets.find((asset) => asset.kind === "video" && asset.metadata)?.metadata}
            mediaAssets={mediaAssets}
            gpuStatus={engineStatus?.gpu ?? null}
            setStatusMessage={setStatusMessage}
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
  }, [activeTab, aiProposals, engineStatus, mediaAssets, projectSettings, recentProjects, timeline]);

  return (
    <main className="app-shell">
      <TopBar
        projectName={project.name}
        onImportMedia={handleImportMedia}
        onSave={() => setStatusMessage("Project saved")}
        onUndo={() => setStatusMessage("Undo command queued")}
        onRedo={() => setStatusMessage("Redo command queued")}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onExport={() => setActiveTab("export")}
      />
      <Tabs items={workspaceTabs} activeId={activeTab} onChange={setActiveTab} />
      <section className="workspace">{activeContent}</section>
      <footer className="status-bar">
        <span>{statusMessage}</span>
        <span className="status-pill">
          <Blocks size={14} />
          {engineStatus?.gpu.name ?? "GPU unknown"}
        </span>
      </footer>

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
