import { open } from "@tauri-apps/plugin-dialog";
import type { AiEditProposal, ProjectSettings, Timeline } from "@ai-video-editor/protocol";
import { engineRpc } from "../commands/commandClient";
import { getProjectNameFromPath } from "../media/mediaTypes";
import type { MediaAsset } from "../media/mediaTypes";

export interface ActiveProject {
  name: string;
  path?: string;
  manifestPath?: string;
  lastSavedAt?: string;
  lastOpenedAt?: string;
}

export interface ProjectSnapshot {
  version: 1;
  savedAt: string;
  project: ActiveProject;
  projectSettings: ProjectSettings;
  mediaAssets: MediaAsset[];
  timeline: Timeline;
  aiProposals: AiEditProposal[];
}

export async function createProjectFromDialog(): Promise<ActiveProject | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return { name: "Browser Project", path: "browser-project" };
  }

  const folder = await open({
    directory: true,
    multiple: false,
    title: "Choose or create a project folder"
  });

  if (!folder || Array.isArray(folder)) {
    return null;
  }

  const name = getProjectNameFromPath(folder);
  await engineRpc("project.create", { name, path: folder });
  return {
    name,
    path: folder,
    manifestPath: `${folder}\\project.aivproj`,
    lastOpenedAt: new Date().toISOString()
  };
}

export async function openProjectFromDialog(): Promise<ActiveProject | null> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return { name: "Browser Project", path: "browser-project", manifestPath: "browser-project/project.aivproj" };
  }

  const selection = await open({
    multiple: false,
    title: "Open AI Video Editor project",
    filters: [{ name: "AI Video Editor Project", extensions: ["aivproj"] }]
  });

  if (!selection || Array.isArray(selection)) {
    return null;
  }

  return {
    name: getProjectNameFromPath(selection),
    manifestPath: selection,
    path: selection.replace(/[\\/]project\.aivproj$/i, ""),
    lastOpenedAt: new Date().toISOString()
  };
}

export async function saveProjectSnapshot(project: ActiveProject, snapshot: ProjectSnapshot) {
  if (!project.path) {
    saveBrowserProjectSnapshot(project, snapshot);
    return;
  }

  if (!("__TAURI_INTERNALS__" in window)) {
    saveBrowserProjectSnapshot(project, snapshot);
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_project_snapshot", { projectPath: project.path, snapshot });
}

export async function loadProjectSnapshot(project: ActiveProject): Promise<ProjectSnapshot | null> {
  if (!project.path || !("__TAURI_INTERNALS__" in window)) {
    return loadBrowserProjectSnapshot(project);
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProjectSnapshot | null>("load_project_snapshot", { projectPath: project.path });
}

export async function validateMediaPaths(paths: string[]): Promise<string[]> {
  if (paths.length === 0 || !("__TAURI_INTERNALS__" in window)) {
    return [];
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("validate_media_paths", { paths });
}

export function loadRecentProjects(): ActiveProject[] {
  try {
    return JSON.parse(localStorage.getItem("ai-video-editor.recentProjects") ?? "[]") as ActiveProject[];
  } catch {
    return [];
  }
}

export function saveRecentProject(project: ActiveProject) {
  const existing = loadRecentProjects();
  const key = project.manifestPath ?? project.path ?? project.name;
  const next = [project, ...existing.filter((item) => (item.manifestPath ?? item.path ?? item.name) !== key)].slice(0, 8);
  localStorage.setItem("ai-video-editor.recentProjects", JSON.stringify(next));
  return next;
}

function saveBrowserProjectSnapshot(project: ActiveProject, snapshot: ProjectSnapshot) {
  localStorage.setItem(browserSnapshotKey(project), JSON.stringify(snapshot));
}

function loadBrowserProjectSnapshot(project: ActiveProject): ProjectSnapshot | null {
  try {
    const raw = localStorage.getItem(browserSnapshotKey(project));
    return raw ? (JSON.parse(raw) as ProjectSnapshot) : null;
  } catch {
    return null;
  }
}

function browserSnapshotKey(project: ActiveProject) {
  return `ai-video-editor.projectSnapshot.${project.manifestPath ?? project.path ?? project.name}`;
}
