import { useState, type FormEvent } from "react";
import type { ProjectSettings } from "@ai-video-editor/protocol";
import type { EditorPreferences } from "../features/settings";
import { Button } from "./Button";

interface SettingsPanelProps {
  projectSettings: ProjectSettings;
  preferences: EditorPreferences;
  hasProject: boolean;
  onApply: (settings: ProjectSettings, preferences: EditorPreferences) => Promise<void>;
  onNavigate: (tab: "shortcuts" | "plugins" | "future-ai") => void;
}

export function SettingsPanel({projectSettings, preferences, hasProject, onApply, onNavigate}: SettingsPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const dimensionsChanged = Number(form.get("width")) !== projectSettings.width || Number(form.get("height")) !== projectSettings.height;
    const nextSettings = hasProject ? {...projectSettings, resolution: dimensionsChanged ? "custom" as const : projectSettings.resolution,
      width: Number(form.get("width")), height: Number(form.get("height")), fps: Number(form.get("fps")) as ProjectSettings["fps"],
      audioEnabled: form.get("audioEnabled") === "on", masterGainDb: Number(form.get("masterGainDb"))} : projectSettings;
    const nextPreferences = {copyMediaToProject: form.get("copyMediaToProject") === "on", autosaveDelayMs: Number(form.get("autosaveDelayMs"))};
    if (hasProject && (!Number.isInteger(nextSettings.width) || !Number.isInteger(nextSettings.height) || nextSettings.width % 2 || nextSettings.height % 2)) {
      setError("Width and height must be even whole numbers."); return;
    }
    setBusy(true); setError("");
    try { await onApply(nextSettings, nextPreferences); }
    catch (failure) {setError(failure instanceof Error ? failure.message : String(failure));}
    finally {setBusy(false);}
  }
  return <form className="editor-settings" onSubmit={(event) => void submit(event)}>
    <fieldset disabled={busy || !hasProject}>
      <legend>Current project</legend>
      <p>Set the timeline canvas and frame rate. Clip times stay in place. Project changes can be undone.</p>
      {!hasProject ? <p>Create or open a project to change these settings.</p> : null}
      <div className="editor-settings-fields">
        <label>Width · px<input name="width" type="number" min={16} max={8192} step={2} required defaultValue={projectSettings.width} /></label>
        <label>Height · px<input name="height" type="number" min={16} max={8192} step={2} required defaultValue={projectSettings.height} /></label>
        <label>Frame rate<select name="fps" defaultValue={projectSettings.fps}>{[24,25,30,50,60].map(fps => <option key={fps} value={fps}>{fps} fps</option>)}</select></label>
        <label>Master gain · dB<input name="masterGainDb" type="number" min={-60} max={12} step={.5} required defaultValue={projectSettings.masterGainDb ?? 0} /></label>
      </div>
      <label className="editor-settings-check"><input name="audioEnabled" type="checkbox" defaultChecked={projectSettings.audioEnabled} />Enable project audio</label>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>Editing preferences</legend>
      <label className="editor-settings-check"><input name="copyMediaToProject" type="checkbox" defaultChecked={preferences.copyMediaToProject} />Copy imported media into the project</label>
      <p>Applies to future imports and file drops. Copies use more disk space and remain available if the original files move. Unchecked imports link to the original files.</p>
      <label className="editor-settings-select">Autosave after the last edit<select name="autosaveDelayMs" defaultValue={preferences.autosaveDelayMs}>
        <option value={4500}>4.5 seconds</option><option value={10000}>10 seconds</option><option value={30000}>30 seconds</option>
      </select></label>
      <p>Preferences are saved on this computer and apply across projects.</p>
    </fieldset>
    <div className="editor-settings-links">
      <Button type="button" disabled={busy} onClick={() => onNavigate("shortcuts")}>Keyboard shortcuts</Button>
      <Button type="button" disabled={busy} onClick={() => onNavigate("plugins")}>Plugins</Button>
      <Button type="button" disabled={busy} onClick={() => onNavigate("future-ai")}>AI & Agents</Button>
    </div>
    {error ? <p role="alert" className="editor-settings-error">{error}</p> : null}
    <div className="modal-actions"><Button type="submit" variant="primary" disabled={busy}>{busy ? "Applying…" : "Apply settings"}</Button></div>
  </form>;
}
