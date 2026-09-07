import { useEffect, useState } from "react";
import { Bot, Check, Copy, Plug, RefreshCw, Unplug } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";

interface BridgeStatus {
  enabled: boolean;
  mcpConfig?: { command: string; args: string[]; env: Record<string, string> };
  codex?: { registered: boolean; enabled: boolean; configPath?: string; error?: string };
  discoveryError?: string;
  startupError?: string;
  registrationError?: string;
}

export function AgentAccessPanel() {
  const desktop = "__TAURI_INTERNALS__" in window;
  const [status, setStatus] = useState<BridgeStatus>({ enabled: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    const refresh = () => {
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke<BridgeStatus>("agent_bridge_status"))
        .then((next) => { if (active) setStatus(next); })
        .catch((error) => { if (active) setError(String(error)); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("focus", refresh); };
  }, [desktop]);
  async function update(command: "agent_bridge_set_enabled" | "agent_bridge_register_codex") {
    setBusy(true); setError(""); setCopied(false);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      try { await invoke(command, command === "agent_bridge_set_enabled" ? { enabled: !status.enabled } : {}); }
      finally { setStatus(await invoke<BridgeStatus>("agent_bridge_status")); }
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  const configuration = status.mcpConfig ? JSON.stringify({ mcpServers: { "video-editor": status.mcpConfig } }, null, 2) : "";
  const notice = error || status.startupError || status.discoveryError || status.registrationError || status.codex?.error;
  return <Panel title="Agent access · MCP" className="agent-access-panel">
    <div className="control-stack">
      <div className="agent-access-heading"><Bot size={24} /><div><strong>Connect your AI agent</strong><p>Use any MCP client to inspect media, edit the live timeline, and export. Edits appear here and support Undo.</p></div><span className={`connection-badge ${status.enabled ? "connected" : ""}`}>{status.enabled ? "Enabled" : "Off"}</span></div>
      <Button variant={status.enabled ? "secondary" : "primary"} icon={status.enabled ? <Unplug size={16} /> : <Plug size={16} />} disabled={!desktop || busy} onClick={() => void update("agent_bridge_set_enabled")}>
        {busy ? "Updating…" : status.enabled ? "Disable agent access" : "Enable agent access"}
      </Button>
      {!desktop ? <p className="muted-line">Agent access is available in the desktop app.</p> : <>
        <div className="agent-access-heading"><div><strong>Codex app</strong><p>{status.codex?.registered
          ? status.codex.enabled ? "Registered automatically. Restart Codex once to load the server, then ask it to inspect the editor."
            : "Registered, but disabled in Codex. Enable video-editor in Codex MCP settings."
          : "The editor registers its MCP server with Codex automatically when it starts."}</p></div><span className={`connection-badge ${status.codex?.enabled ? "connected" : ""}`}>{status.codex?.registered ? status.codex.enabled ? "Registered" : "Disabled" : "Needs setup"}</span></div>
        {!status.enabled && status.codex?.registered ? <p className="muted-line">Enable agent access above to let Codex use the open editor.</p> : null}
        <Button icon={<RefreshCw size={15} />} disabled={busy} onClick={() => void update("agent_bridge_register_codex")}>Refresh Codex registration</Button>
      </>}
      {notice ? <p role="alert" className="inline-notice">{notice}</p> : null}
      {configuration ? <details>
        <summary>Connect another MCP client</summary>
        <p className="muted-line">Add this server to your client's MCP configuration. It finds the active editor automatically; keep the editor open.</p>
        <pre className="agent-config">{configuration}</pre>
        <Button icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void navigator.clipboard.writeText(configuration).then(() => setCopied(true)).catch(() => setError("Could not copy. Select the configuration text to copy it manually."))}>{copied ? "Copied" : "Copy configuration"}</Button>
      </details> : null}
      <small className="muted-line">Your access setting is remembered on this computer. Closing the editor ends the connection; it reconnects on the next launch when access is enabled. Agents can submit proposals for review or apply edits directly.</small>
    </div>
  </Panel>;
}
