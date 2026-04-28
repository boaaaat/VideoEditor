import { open } from "@tauri-apps/plugin-dialog";
import { engineRpc } from "../commands/commandClient";
import { getProjectNameFromPath } from "../media/mediaTypes";

export interface ActiveProject {
  name: string;
  path?: string;
  manifestPath?: string;
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
    manifestPath: `${folder}\\project.aivproj`
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
    path: selection.replace(/[\\/]project\.aivproj$/i, "")
  };
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
