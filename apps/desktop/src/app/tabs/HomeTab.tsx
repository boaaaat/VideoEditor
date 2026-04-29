import type { EngineStatus } from "@ai-video-editor/protocol";
import { FolderOpen, FolderPlus, HardDrive, PlugZap } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import type { LogStatus } from "../../features/logging/appLog";
import { createProjectFromDialog, openProjectFromDialog, type ActiveProject } from "../../features/projects/projectActions";

interface HomeTabProps {
  engineStatus: EngineStatus | null;
  recentProjects: ActiveProject[];
  onProjectOpen: (project: ActiveProject) => void | Promise<void>;
  setStatusMessage: LogStatus;
}

export function HomeTab({ engineStatus, recentProjects, onProjectOpen, setStatusMessage }: HomeTabProps) {
  async function createProject() {
    try {
      const project = await createProjectFromDialog();
      if (project) {
        onProjectOpen(project);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "New project failed", { level: "error" });
    }
  }

  async function openProject() {
    try {
      const project = await openProjectFromDialog();
      if (project) {
        onProjectOpen(project);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Open project failed", { level: "error" });
    }
  }

  return (
    <div className="home-grid">
      <Panel title="Project Dashboard">
        <div className="home-actions">
          <Button icon={<FolderPlus size={17} />} variant="primary" onClick={createProject}>
            New Project
          </Button>
          <Button icon={<FolderOpen size={17} />} onClick={openProject}>
            Open Project
          </Button>
        </div>
        <div className="recent-list">
          {recentProjects.length > 0 ? (
            recentProjects.map((project) => (
              <button type="button" key={project.manifestPath ?? project.path ?? project.name} onClick={() => void onProjectOpen(project)}>
                <span>{project.name}</span>
                {project.path ? <small>{project.path}</small> : null}
                {project.lastSavedAt ? <small>Saved {formatRecentTime(project.lastSavedAt)}</small> : null}
              </button>
            ))
          ) : (
            <div className="empty-state">No recent projects.</div>
          )}
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

function formatRecentTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
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
