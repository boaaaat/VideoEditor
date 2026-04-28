export interface ProjectManifest {
  version: 1;
  name: string;
  database: "project.db";
  createdWith: "AI Video Editor v0.1";
}

export interface ProjectFolderLayout {
  manifestPath: string;
  databasePath: string;
  mediaPath: string;
  proxiesPath: string;
  thumbnailsPath: string;
  waveformsPath: string;
  cachePath: string;
  lutsPath: string;
  pluginsPath: string;
  exportsPath: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  manifest: ProjectManifest;
  createdAt: string;
}
