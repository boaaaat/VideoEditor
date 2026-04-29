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
    throw new Error("Project folders require the desktop app.");
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
    throw new Error("Project folders require the desktop app.");
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
    throw new Error("Choose or create a project folder before saving.");
  }

  if (!("__TAURI_INTERNALS__" in window)) {
    saveBrowserProjectSnapshot(project, snapshot);
    return;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_project_snapshot", { projectPath: project.path, snapshot });
}

export async function loadProjectSnapshot(project: ActiveProject): Promise<ProjectSnapshot | null> {
  let snapshot: ProjectSnapshot | null;
  if (!project.path) {
    return null;
  }

  if (!("__TAURI_INTERNALS__" in window)) {
    snapshot = loadBrowserProjectSnapshot(project);
  } else {
    const { invoke } = await import("@tauri-apps/api/core");
    snapshot = await invoke<ProjectSnapshot | null>("load_project_snapshot", { projectPath: project.path });
  }

  return snapshot ? normalizeSnapshotMediaPaths(snapshot, project.path) : null;
}

export async function validateMediaPaths(paths: string[], projectPath?: string): Promise<string[]> {
  if (paths.length === 0 || !("__TAURI_INTERNALS__" in window)) {
    return [];
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("validate_media_paths", { paths, projectPath });
}

export function loadRecentProjects(): ActiveProject[] {
  try {
    const projects = JSON.parse(localStorage.getItem("ai-video-editor.recentProjects") ?? "[]") as ActiveProject[];
    const validProjects = projects.filter(hasValidProjectPath);
    if (validProjects.length !== projects.length) {
      localStorage.setItem("ai-video-editor.recentProjects", JSON.stringify(validProjects));
    }
    return validProjects;
  } catch {
    return [];
  }
}

export function saveRecentProject(project: ActiveProject) {
  if (!hasValidProjectPath(project)) {
    return loadRecentProjects();
  }

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

export function removePathlessProjectStorage() {
  const staleSnapshotKeys = [
    "ai-video-editor.projectSnapshot.Untitled Project",
    "ai-video-editor.projectSnapshot.Browser Project",
    "ai-video-editor.projectSnapshot.browser-project",
    "ai-video-editor.projectSnapshot.browser-project/project.aivproj",
    "ai-video-editor.projectSnapshot.null",
    "ai-video-editor.projectSnapshot.undefined"
  ];

  for (const key of staleSnapshotKeys) {
    localStorage.removeItem(key);
  }
  localStorage.setItem("ai-video-editor.recentProjects", JSON.stringify(loadRecentProjects()));
}

function hasValidProjectPath(project: ActiveProject) {
  const path = project.path?.trim();
  return Boolean(path && path !== "browser-project" && path.toLowerCase() !== "null" && path.toLowerCase() !== "undefined");
}

function normalizeSnapshotMediaPaths(snapshot: ProjectSnapshot, projectPath?: string): ProjectSnapshot {
  if (!projectPath) {
    return snapshot;
  }

  return {
    ...snapshot,
    mediaAssets: snapshot.mediaAssets.map((asset) => {
      const path = resolveProjectMediaPath(asset.path, projectPath);
      return {
        ...asset,
        path,
        metadata: asset.metadata ? { ...asset.metadata, path: resolveProjectMediaPath(asset.metadata.path, projectPath) } : asset.metadata
      };
    })
  };
}

function resolveProjectMediaPath(path: string, projectPath: string) {
  const trimmedPath = path.trim();
  if (!trimmedPath || isAbsoluteOrUrlPath(trimmedPath)) {
    return trimmedPath;
  }

  const separator = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${separator}${trimmedPath.replace(/^[\\/]+/, "")}`;
}

function isAbsoluteOrUrlPath(path: string) {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/") || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(path);
}
