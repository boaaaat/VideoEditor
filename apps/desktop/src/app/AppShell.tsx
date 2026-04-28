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
import type { EngineStatus } from "@ai-video-editor/protocol";
import { Tabs, type TabItem } from "../components/Tabs";
import { Modal } from "../components/Modal";
import { getEngineStatus } from "../features/commands/commandClient";
import { isTypingTarget, shortcutDefinitions } from "../features/commands/shortcuts";
import { importMediaFiles, type ImportMediaResult } from "../features/media/importMedia";
import type { MediaAsset } from "../features/media/mediaTypes";
import { loadRecentProjects, saveRecentProject, type ActiveProject } from "../features/projects/projectActions";
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

export function AppShell() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("edit");
  const [project, setProject] = useState<ActiveProject>({ name: "Untitled Project" });
  const [recentProjects, setRecentProjects] = useState<ActiveProject[]>([]);
  const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready");

  useEffect(() => {
    setRecentProjects(loadRecentProjects());

    getEngineStatus()
      .then(setEngineStatus)
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
    setStatusMessage(`Imported ${result.media.length} media file${result.media.length === 1 ? "" : "s"}`);
    setActiveTab("edit");
  }

  async function handleImportMedia() {
    applyImportedMedia(await importMediaFiles());
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
            onImportMedia={handleImportMedia}
            onImportMediaResult={applyImportedMedia}
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
        return <ExportTab setStatusMessage={setStatusMessage} />;
      case "future-ai":
        return <FutureAiTab />;
      default:
        return null;
    }
  }, [activeTab, engineStatus, mediaAssets, recentProjects]);

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
    </main>
  );
}
