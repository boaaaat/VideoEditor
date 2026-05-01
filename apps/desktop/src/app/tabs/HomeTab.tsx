import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { EngineStatus } from "@ai-video-editor/protocol";
import { Clipboard, FolderOpen, FolderPlus, HardDrive, LogOut, PlugZap, Trash2 } from "lucide-react";
import { Button } from "../../components/Button";
import { ContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { Panel } from "../../components/Panel";
import type { LogStatus } from "../../features/logging/appLog";
import {
  createProjectFromDialog,
  deleteProjectFolder,
  errorMessage,
  openProjectFromDialog,
  removeRecentProject,
  revealProjectInExplorer,
  type ActiveProject
} from "../../features/projects/projectActions";

interface HomeTabProps {
  engineStatus: EngineStatus | null;
  recentProjects: ActiveProject[];
  onProjectOpen: (project: ActiveProject) => void | Promise<void>;
  onRecentProjectsChange: (projects: ActiveProject[]) => void;
  onProjectDeleted: (project: ActiveProject) => void;
  setStatusMessage: LogStatus;
}

interface ProjectContextMenuState {
  x: number;
  y: number;
  project: ActiveProject;
}

export function HomeTab({ engineStatus, recentProjects, onProjectOpen, onRecentProjectsChange, onProjectDeleted, setStatusMessage }: HomeTabProps) {
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);

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

  function openProjectContextMenu(event: ReactMouseEvent<HTMLButtonElement>, project: ActiveProject) {
    event.preventDefault();
    event.stopPropagation();
    setProjectContextMenu({
      x: event.clientX,
      y: event.clientY,
      project
    });
  }

  function openProjectKeyboardMenu(event: KeyboardEvent<HTMLButtonElement>, project: ActiveProject) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
      return;
    }

    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setProjectContextMenu({
      x: rect.left + 16,
      y: rect.top + 16,
      project
    });
  }

  function projectMenuItems(project: ActiveProject): ContextMenuItem[] {
    const hasDesktopShell = "__TAURI_INTERNALS__" in window;
    return [
      {
        id: "open-project",
        label: "Open Project",
        icon: <FolderOpen size={15} />,
        onSelect: () => void onProjectOpen(project)
      },
      {
        id: "reveal-project",
        label: "Reveal in Explorer",
        icon: <FolderOpen size={15} />,
        disabled: !hasDesktopShell,
        onSelect: () => void revealProject(project)
      },
      {
        id: "copy-project-path",
        label: "Copy Path",
        icon: <Clipboard size={15} />,
        disabled: !project.path,
        onSelect: () => void copyProjectPath(project)
      },
      {
        id: "remove-recent-project",
        label: "Remove From Dashboard",
        icon: <LogOut size={15} />,
        onSelect: () => removeProjectFromDashboard(project)
      },
      {
        id: "delete-project",
        label: "Delete Project",
        icon: <Trash2 size={15} />,
        disabled: !project.path,
        danger: true,
        onSelect: () => void deleteProject(project)
      }
    ];
  }

  async function revealProject(project: ActiveProject) {
    try {
      await revealProjectInExplorer(project);
      setStatusMessage(`Revealed ${project.name} in Explorer`, { level: "success", details: { projectPath: project.path } });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Reveal project failed", { level: "error" });
    }
  }

  async function copyProjectPath(project: ActiveProject) {
    if (!project.path) {
      setStatusMessage("Project path is missing", { level: "warning" });
      return;
    }

    try {
      await navigator.clipboard.writeText(project.path);
      setStatusMessage(`Copied path for ${project.name}`, { level: "success", details: { projectPath: project.path } });
    } catch {
      setStatusMessage("Copy path failed", { level: "error", details: { projectPath: project.path } });
    }
  }

  function removeProjectFromDashboard(project: ActiveProject) {
    onRecentProjectsChange(removeRecentProject(project));
    setStatusMessage(`Removed ${project.name} from dashboard`, { details: { projectPath: project.path } });
  }

  async function deleteProject(project: ActiveProject) {
    const confirmed = window.confirm(`Delete "${project.name}" from disk?\n\nThis removes the project folder:\n${project.path ?? "(missing path)"}`);
    if (!confirmed) {
      return;
    }

    try {
      const nextProjects = await deleteProjectFolder(project);
      onRecentProjectsChange(nextProjects);
      onProjectDeleted(project);
      setStatusMessage(`Deleted project: ${project.name}`, { level: "success", details: { projectPath: project.path } });
    } catch (error) {
      setStatusMessage(errorMessage(error, "Delete project failed"), { level: "error", details: { projectPath: project.path } });
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
              <button
                type="button"
                key={project.manifestPath ?? project.path ?? project.name}
                onClick={() => void onProjectOpen(project)}
                onContextMenu={(event) => openProjectContextMenu(event, project)}
                onKeyDown={(event) => openProjectKeyboardMenu(event, project)}
              >
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
      {projectContextMenu ? (
        <ContextMenu
          x={projectContextMenu.x}
          y={projectContextMenu.y}
          items={projectMenuItems(projectContextMenu.project)}
          onClose={() => setProjectContextMenu(null)}
        />
      ) : null}
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
