import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, Power, RefreshCw, Trash2 } from "lucide-react";
import type { AiEditProposal, InstalledPlugin, PluginManifest, PluginParameter } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Modal } from "../../components/Modal";
import { Toggle } from "../../components/Toggle";
import type { LogStatus } from "../../features/logging/appLog";
import type { ProjectSnapshot } from "../../features/projects/projectActions";
import { pluginInvoke, runEditorPlugin, type PluginListing, type PluginRunResult, type PluginScope } from "../../features/plugins/runtime";
import { pluginPermissionLabels } from "../../features/plugins";

interface PluginsTabProps {
  snapshot: ProjectSnapshot; playheadUs: number; onPause: () => void;
  onProposal: (proposal: AiEditProposal) => void;
  onApplyProposal: (proposalId: string) => Promise<boolean>;
  setStatusMessage: LogStatus;
}

export function PluginsTab({ snapshot, playheadUs, onPause, onProposal, onApplyProposal, setStatusMessage }: PluginsTabProps) {
  const [scope, setScope] = useState<PluginScope>(snapshot.project.path ? "project" : "user");
  const projectPath = scope === "project" ? snapshot.project.path : undefined;
  const [listing, setListing] = useState<PluginListing>({ plugins: [], developerMode: false });
  const [selectedId, setSelectedId] = useState("");
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [inspection, setInspection] = useState<{folder: string; manifest: PluginManifest; fileCount: number} | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<PluginRunResult | null>(null);
  const [removeTarget, setRemoveTarget] = useState<InstalledPlugin | null>(null);
  const controller = useRef<AbortController | null>(null);
  const selected = listing.plugins.find((plugin) => plugin.manifest.id === selectedId);
  const desktop = "__TAURI_INTERNALS__" in window;

  async function refresh() {
    const next = await pluginInvoke<PluginListing>("plugins_list", { projectPath });
    setListing(next);
  }
  useEffect(() => {
    let disposed = false;
    setSelectedId(""); setParameters({}); setResult(null); setError("");
    if (desktop) void pluginInvoke<PluginListing>("plugins_list", { projectPath }).then((value) => { if (!disposed) setListing(value); }).catch((error) => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; controller.current?.abort(); };
  }, [desktop, projectPath]);
  function report(message: string) { setError(message); setStatusMessage(message, { level: "error", source: "plugin" }); }
  async function action(label: string, run: () => Promise<void>) {
    setError(""); setBusy(label);
    try { await run(); await refresh(); }
    catch (error) { report(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(""); }
  }
  async function inspect() {
    await action("Inspecting package", async () => {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const folder = await open({directory: true, multiple: false, title: "Select a plugin package folder"});
      if (!folder || Array.isArray(folder)) return;
      const info = await pluginInvoke<{manifest: PluginManifest; fileCount: number}>("plugins_inspect", {folder});
      setInspection({folder, ...info});
    });
  }
  async function runSelected() {
    if (!selected) return;
    onPause(); controller.current = new AbortController(); setResult(null);
    await action(`Running ${selected.manifest.name}`, async () => {
      const result = await runEditorPlugin({ pluginId: selected.manifest.id, projectPath, snapshot, playheadUs, parameters, signal: controller.current!.signal });
      for (const log of result.logs) setStatusMessage(`${selected.manifest.name}: ${log.message}`, { level: log.level, source: "plugin", details: { pluginId: selected.manifest.id } });
      if (result.proposal) onProposal(result.proposal);
      setResult(result);
      setStatusMessage(`${selected.manifest.name}: ${result.summary}`, { source: "plugin", level: "success", details: { pluginId: selected.manifest.id, proposalId: result.proposal?.id } });
    });
  }

  return <div className="plugin-workspace">
    <Panel title="Plugins">
      <div className="plugin-toolbar">
        <label>Install location<select value={scope} disabled={Boolean(busy)} onChange={(event) => setScope(event.target.value as PluginScope)}>
          {snapshot.project.path ? <option value="project">This project</option> : null}<option value="user">All projects</option>
        </select></label>
        <Button icon={<FolderOpen size={16} />} disabled={!desktop || Boolean(busy)} onClick={() => void inspect()}>Install package</Button>
        <Button icon={<RefreshCw size={16} />} disabled={!desktop || Boolean(busy)} onClick={() => void action("Refreshing plugins", refresh)}>Refresh</Button>
      </div>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {!desktop ? <p className="empty-state">Open the desktop app to install and run plugins.</p> : listing.plugins.length === 0 ? <div className="empty-state"><strong>No plugins installed here</strong><span>Choose a folder containing plugin.json and its compiled JavaScript or native DLL entry.</span><span>Example packages and the plugin SDK are included in the repository.</span></div> : <div className="plugin-list">
        {listing.plugins.map((plugin) => <button type="button" key={plugin.manifest.id} className={`plugin-card${selectedId === plugin.manifest.id ? " selected" : ""}`} disabled={Boolean(busy)} onClick={() => {setSelectedId(plugin.manifest.id); setParameters({}); setResult(null);}}>
          <strong>{plugin.manifest.name}</strong><span>{plugin.manifest.description ?? plugin.manifest.id}</span><small>{plugin.manifest.version} · {plugin.manifest.type === "cpp" ? "Native C++" : "JavaScript"} · {plugin.enabled ? "Enabled" : "Disabled"}</small>{plugin.lastError ? <span className="plugin-error">{plugin.lastError}</span> : null}
        </button>)}
      </div>}
    </Panel>
    <div className="control-stack">
      <Panel title={selected?.manifest.name ?? "Plugin details"}>
        {selected ? <div className="control-stack">
          <p>{selected.manifest.description ?? "This plugin returns a result or proposes edits for review."}</p>
          <PermissionList manifest={selected.manifest} />
          {selected.manifest.type === "cpp" ? <p className="muted-line">Native plugins have the same file and network access as this app. Enable only DLLs you trust. Each run uses a separate process.</p> : <p className="muted-line">Runs in an isolated worker without network or direct file access. Proposed edits require Apply.</p>}
          <div className="export-actions">
            <Button icon={<Power size={16} />} disabled={Boolean(busy) || selected.invalid || (!selected.enabled && selected.manifest.type === "cpp" && !listing.developerMode)} onClick={() => void action("Updating plugin", async () => {
              await pluginInvoke("plugins_set_enabled", {pluginId: selected.manifest.id, projectPath, enabled: !selected.enabled});
              setStatusMessage(`${selected.manifest.name} ${selected.enabled ? "disabled" : "enabled"}`, {source:"plugin"});
            })}>{selected.enabled ? "Disable" : "Enable"}</Button>
            <Button icon={<Trash2 size={16} />} disabled={Boolean(busy)} onClick={() => setRemoveTarget(selected)}>Uninstall</Button>
          </div>
          <fieldset className="inspector-fields" disabled={!selected.enabled || Boolean(busy) || (selected.manifest.type === "cpp" && !listing.developerMode)}>
            {(selected.manifest.parameters ?? []).map((field) => <ParameterField key={`${selected.manifest.id}:${field.id}`} field={field} value={parameters[field.id] ?? field.default} onChange={(value) => setParameters((current) => ({...current,[field.id]:value}))} />)}
            <Button icon={<Play size={16} />} variant="primary" onClick={() => void runSelected()}>Run plugin</Button>
          </fieldset>
          {selected.manifest.type === "cpp" && !listing.developerMode ? <p className="muted-line">Enable native development below to run this plugin.</p> : null}
          {selected.lastRunAt ? <small>Last run {new Date(selected.lastRunAt).toLocaleString()}</small> : null}
        </div> : <div className="empty-state">Select an installed plugin to inspect its permissions and run it.</div>}
      </Panel>
      <Panel title="Native development">
        <Toggle label="Allow native C++ plugins in this location" checked={listing.developerMode} disabled={!desktop || Boolean(busy)} onChange={(event) => void action("Updating native plugin mode", async () => {await pluginInvoke("plugins_set_developer_mode", {projectPath, enabled:event.target.checked});})} />
        <p className="muted-line">Off by default. This permits enabling trusted 64-bit DLLs that implement the editor plugin ABI.</p>
      </Panel>
    </div>
    <Modal open={Boolean(inspection)} title="Install plugin" onClose={() => {if (!busy) setInspection(null);}}>
      {inspection ? <div className="control-stack"><h3>{inspection.manifest.name} · {inspection.manifest.version}</h3><p>{inspection.manifest.description}</p><PermissionList manifest={inspection.manifest} /><small>{inspection.fileCount} files · {scope === "project" ? "This project" : "All projects"}</small><p className="muted-line">The package is copied into the selected location and starts disabled. Updating an existing package requires enabling it again.</p><Button variant="primary" disabled={Boolean(busy)} onClick={() => void action("Installing plugin", async () => {
        await pluginInvoke("plugins_install", {folder:inspection.folder,projectPath,replace:listing.plugins.some((plugin) => plugin.manifest.id === inspection.manifest.id)});
        setSelectedId(inspection.manifest.id); setInspection(null); setStatusMessage(`Installed ${inspection.manifest.name}`, {source:"plugin",level:"success"});
      })}>{listing.plugins.some((plugin) => plugin.manifest.id === inspection.manifest.id) ? "Update package" : "Install package"}</Button></div> : null}
    </Modal>
    <Modal open={Boolean(removeTarget)} title="Uninstall plugin" onClose={() => {if (!busy) setRemoveTarget(null);}}>
      <p>Remove {removeTarget?.manifest.name} from {scope === "project" ? "this project" : "all projects"}? Edits already applied remain on the timeline.</p><Button disabled={Boolean(busy)} onClick={() => void action("Removing plugin", async () => {await pluginInvoke("plugins_remove", {pluginId:removeTarget!.manifest.id,projectPath}); setRemoveTarget(null);setSelectedId("");setResult(null);})}>Uninstall</Button>
    </Modal>
    <Modal open={Boolean(busy) && !inspection && !removeTarget} title={busy || "Plugin operation"} onClose={() => controller.current?.abort()}><p role="status">{busy}…</p>{busy.startsWith("Running") ? <Button onClick={() => controller.current?.abort()}>Cancel</Button> : null}</Modal>
    <Modal open={Boolean(result) && !busy} title="Plugin result" onClose={() => setResult(null)}>
      {result ? <div className="control-stack"><p>{result.summary}</p>{result.output ? <pre className="log-view">{result.output}</pre> : null}{result.proposal ? <><p>{result.commands.length} proposed edits. Apply creates one undo step.</p><details><summary>Inspect commands</summary><pre className="log-view">{JSON.stringify(result.commands,null,2)}</pre></details><div className="export-actions"><Button variant="primary" disabled={Boolean(busy)} onClick={() => void action("Applying plugin edits", async () => {if (await onApplyProposal(result.proposal!.id)) setResult(null);})}>Apply edits</Button><Button onClick={() => setResult(null)}>Keep in proposal queue</Button></div></> : <Button onClick={() => setResult(null)}>Done</Button>}</div> : null}
    </Modal>
  </div>;
}

function PermissionList({manifest}:{manifest:PluginManifest}) {
  return <div className="plugin-permissions"><strong>Permissions</strong>{manifest.permissions.length ? manifest.permissions.map((permission) => <span key={permission}>{pluginPermissionLabels[permission] ?? permission}</span>) : <span>No project data requested</span>}</div>;
}
function ParameterField({field,value,onChange}:{field:PluginParameter;value:unknown;onChange:(value:unknown)=>void}) {
  if (field.type === "boolean") return <Toggle label={field.label} checked={Boolean(value)} onChange={(event)=>onChange(event.target.checked)} />;
  if (field.options) return <label>{field.label}<select value={String(value ?? field.options[0])} onChange={(event)=>onChange(event.target.value)}>{field.options.map((option)=><option key={option}>{option}</option>)}</select></label>;
  return <label>{field.label}<input type={field.type === "number" ? "number" : "text"} value={value === undefined ? "" : String(value)} min={field.min} max={field.max} step={field.step ?? 1} required={field.required} maxLength={4000} onChange={(event)=>onChange(field.type === "number" ? event.target.valueAsNumber : event.target.value)} /></label>;
}
