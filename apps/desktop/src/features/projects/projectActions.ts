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

  await engineRpc<ProjectSnapshot>("project.save_state", snapshot);
}

export async function loadProjectSnapshot(project: ActiveProject): Promise<ProjectSnapshot | null> {
  let snapshot: ProjectSnapshot | null;
  if (!project.path) {
    return null;
  }

  if (!("__TAURI_INTERNALS__" in window)) {
    snapshot = loadBrowserProjectSnapshot(project);
  } else {
    snapshot = await engineRpc<ProjectSnapshot>("project.open", project);
    const normalizedSnapshot = normalizeSnapshotTimeline(normalizeSnapshotMediaPaths(snapshot, project.path));
    if (isEmptyProjectSnapshot(normalizedSnapshot)) {
      const legacySnapshot = await loadLegacyCacheSnapshot(project);
      if (legacySnapshot && !isEmptyProjectSnapshot(legacySnapshot)) {
        await saveProjectSnapshot(project, legacySnapshot);
        return normalizeSnapshotTimeline(normalizeSnapshotMediaPaths(legacySnapshot, project.path));
      }
    }
    return normalizedSnapshot;
  }

  return snapshot ? normalizeSnapshotTimeline(normalizeSnapshotMediaPaths(snapshot, project.path)) : null;
}

async function loadLegacyCacheSnapshot(project: ActiveProject): Promise<ProjectSnapshot | null> {
  if (!project.path || !("__TAURI_INTERNALS__" in window)) {
    return null;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ProjectSnapshot | null>("load_project_snapshot", { projectPath: project.path });
  } catch {
    return null;
  }
}

export async function validateMediaPaths(paths: string[], projectPath?: string): Promise<string[]> {
  if (paths.length === 0 || !("__TAURI_INTERNALS__" in window)) {
    return [];
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("validate_media_paths", { paths, projectPath });
}

export async function revealProjectInExplorer(project: ActiveProject) {
  if (!project.path) {
    throw new Error("Project path is missing.");
  }
  if (!("__TAURI_INTERNALS__" in window)) {
    throw new Error("Reveal in Explorer is available in the desktop app.");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_media_path", { path: project.path });
}

export async function deleteProjectFolder(project: ActiveProject) {
  if (!project.path) {
    throw new Error("Project path is missing.");
  }

  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_project_folder", { projectPath: project.path });
  } else {
    localStorage.removeItem(browserSnapshotKey(project));
  }

  return removeRecentProject(project);
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
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
  const key = projectStorageKey(project);
  const next = [project, ...existing.filter((item) => projectStorageKey(item) !== key)].slice(0, 8);
  localStorage.setItem("ai-video-editor.recentProjects", JSON.stringify(next));
  return next;
}

export function removeRecentProject(project: ActiveProject) {
  const key = projectStorageKey(project);
  const next = loadRecentProjects().filter((item) => projectStorageKey(item) !== key);
  localStorage.setItem("ai-video-editor.recentProjects", JSON.stringify(next));
  localStorage.removeItem(browserSnapshotKey(project));
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
  return `ai-video-editor.projectSnapshot.${projectStorageKey(project)}`;
}

function projectStorageKey(project: ActiveProject) {
  return project.manifestPath ?? project.path ?? project.name;
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

function normalizeSnapshotTimeline(snapshot: ProjectSnapshot): ProjectSnapshot {
  return {
    ...snapshot,
    timeline: {
      ...snapshot.timeline,
      tracks: snapshot.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ({
          ...clip,
          speedPercent: normalizeSpeedPercent((clip as { speedPercent?: unknown }).speedPercent)
        }))
      }))
    }
  };
}

function isEmptyProjectSnapshot(snapshot: ProjectSnapshot) {
  const clipCount = snapshot.timeline?.tracks?.reduce((count, track) => count + track.clips.length, 0) ?? 0;
  return (snapshot.mediaAssets?.length ?? 0) === 0 && clipCount === 0 && (snapshot.aiProposals?.length ?? 0) === 0;
}

function normalizeSpeedPercent(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(400, Math.max(25, Math.round(numeric))) : 100;
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
