import type { EngineStatus } from "@ai-video-editor/protocol";
import { FolderOpen, FolderPlus, HardDrive, PlugZap } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";

interface HomeTabProps {
  engineStatus: EngineStatus | null;
  onProjectNameChange: (name: string) => void;
}

export function HomeTab({ engineStatus, onProjectNameChange }: HomeTabProps) {
  return (
    <div className="home-grid">
      <Panel title="Project Dashboard">
        <div className="home-actions">
          <Button icon={<FolderPlus size={17} />} variant="primary" onClick={() => onProjectNameChange("New Project")}>
            New Project
          </Button>
          <Button icon={<FolderOpen size={17} />}>Open Project</Button>
        </div>
        <div className="recent-list">
          <button type="button">Untitled Project</button>
          <button type="button">Demo Rough Cut</button>
        </div>
      </Panel>

      <Panel title="System Status">
        <div className="status-grid">
          <StatusItem label="FFmpeg" value={engineStatus?.ffmpeg.available ? "Available" : "Missing"} detail={engineStatus?.ffmpeg.path ?? engineStatus?.ffmpeg.message} />
          <StatusItem label="FFprobe" value={engineStatus?.ffprobe.available ? "Available" : "Missing"} detail={engineStatus?.ffprobe.path ?? engineStatus?.ffprobe.message} />
          <StatusItem label="GPU" value={engineStatus?.gpu.available ? "Available" : "Unknown"} detail={engineStatus?.gpu.name ?? engineStatus?.gpu.message} />
          <StatusItem label="Preview" value="Local stream" detail={engineStatus?.previewUrl ?? "Waiting for engine"} />
        </div>
      </Panel>

      <Panel title="Installed Plugins">
        <div className="empty-state">
          <PlugZap size={24} />
          <span>No plugins enabled yet.</span>
        </div>
      </Panel>

      <Panel title="Storage">
        <div className="empty-state">
          <HardDrive size={24} />
          <span>Project folders store databases, proxies, thumbnails, waveforms, LUTs, plugins, and exports.</span>
        </div>
      </Panel>
    </div>
  );
}

function StatusItem({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="status-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}
