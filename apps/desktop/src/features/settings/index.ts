export interface AppSettings {
  linkMediaByDefault: boolean;
  developerModePlugins: boolean;
  futureAiAutoAccept: boolean;
}

export const defaultAppSettings: AppSettings = {
  linkMediaByDefault: true,
  developerModePlugins: false,
  futureAiAutoAccept: false
};
