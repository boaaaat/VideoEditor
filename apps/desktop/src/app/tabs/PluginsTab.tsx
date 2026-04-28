import { Bug, Code2, Power, ShieldCheck, TerminalSquare } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";

export function PluginsTab() {
  return (
    <div className="tool-grid">
      <Panel title="Installed Plugins">
        <div className="plugin-row">
          <div>
            <strong>Example Timeline Command</strong>
            <span>typescript - disabled</span>
          </div>
          <Button icon={<Power size={16} />}>Enable</Button>
        </div>
      </Panel>
      <Panel title="Permissions">
        <div className="feature-list">
          <span><ShieldCheck size={16} /> timeline.read</span>
          <span><ShieldCheck size={16} /> timeline.write</span>
          <span><ShieldCheck size={16} /> filesystem.projectOnly</span>
        </div>
      </Panel>
      <Panel title="Developer Mode">
        <div className="control-stack">
          <Toggle label="Allow dev C++ DLL plugins" checked={false} />
          <span className="muted-line"><Code2 size={15} /> Native plugins are disabled unless developer mode is enabled.</span>
          <span className="muted-line"><TerminalSquare size={15} /> Plugin logs write to the project logs folder.</span>
          <span className="muted-line"><Bug size={15} /> Crashes are isolated by disabling the plugin on next load.</span>
        </div>
      </Panel>
    </div>
  );
}
