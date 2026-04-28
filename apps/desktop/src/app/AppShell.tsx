import { useEffect, useMemo, useState } from "react";
import {
  AudioLines,
  Blocks,
  Bot,
  Clapperboard,
  Download,
  Home,
  Palette,
  Puzzle,
  WandSparkles
} from "lucide-react";
import type { EngineStatus } from "@ai-video-editor/protocol";
import { Tabs, type TabItem } from "../components/Tabs";
import { Modal } from "../components/Modal";
import { getEngineStatus } from "../features/commands/commandClient";
import { TopBar } from "./topbar/TopBar";
import { HomeTab } from "./tabs/HomeTab";
import { EditTab } from "./tabs/EditTab";
import { AudioTab } from "./tabs/AudioTab";
import { ColorTab } from "./tabs/ColorTab";
import { EffectsTab } from "./tabs/EffectsTab";
import { PluginsTab } from "./tabs/PluginsTab";
import { ExportTab } from "./tabs/ExportTab";
import { FutureAiTab } from "./tabs/FutureAiTab";

export type WorkspaceTab = "home" | "edit" | "audio" | "color" | "effects" | "plugins" | "export" | "future-ai";

const workspaceTabs: TabItem<WorkspaceTab>[] = [
  { id: "home", label: "Home", icon: <Home size={16} /> },
  { id: "edit", label: "Edit", icon: <Clapperboard size={16} /> },
  { id: "audio", label: "Audio", icon: <AudioLines size={16} /> },
  { id: "color", label: "Color", icon: <Palette size={16} /> },
  { id: "effects", label: "Effects", icon: <WandSparkles size={16} /> },
  { id: "plugins", label: "Plugins", icon: <Puzzle size={16} /> },
  { id: "export", label: "Export", icon: <Download size={16} /> },
  { id: "future-ai", label: "Future AI", icon: <Bot size={16} /> }
];

export function AppShell() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("edit");
  const [projectName, setProjectName] = useState("Untitled Project");
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready");

  useEffect(() => {
    getEngineStatus()
      .then(setEngineStatus)
      .catch((error) => {
        setStatusMessage(error instanceof Error ? error.message : "Engine status failed");
      });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }

      if (event.ctrlKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setActiveTab("export");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeContent = useMemo(() => {
    switch (activeTab) {
      case "home":
        return <HomeTab engineStatus={engineStatus} onProjectNameChange={setProjectName} />;
      case "edit":
        return <EditTab previewUrl={engineStatus?.previewUrl} setStatusMessage={setStatusMessage} />;
      case "audio":
        return <AudioTab />;
      case "color":
        return <ColorTab />;
      case "effects":
        return <EffectsTab />;
      case "plugins":
        return <PluginsTab />;
      case "export":
        return <ExportTab setStatusMessage={setStatusMessage} />;
      case "future-ai":
        return <FutureAiTab />;
      default:
        return null;
    }
  }, [activeTab, engineStatus]);

  return (
    <main className="app-shell">
      <TopBar
        projectName={projectName}
        onImportComplete={(message) => setStatusMessage(message)}
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
          {[
            ["Import Media", "Ctrl+I"],
            ["Split at Playhead", "S"],
            ["Ripple Delete", "Shift+Delete"],
            ["Export Timeline", "Ctrl+E"],
            ["Toggle Snapping", "N"]
          ].map(([name, shortcut]) => (
            <button key={name} type="button" onClick={() => setCommandPaletteOpen(false)}>
              <span>{name}</span>
              <kbd>{shortcut}</kbd>
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
