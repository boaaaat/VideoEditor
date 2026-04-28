export interface ProjectViewState {
  name: string;
  path?: string;
  dirty: boolean;
}

export const defaultProjectViewState: ProjectViewState = {
  name: "Untitled Project",
  dirty: false
};
