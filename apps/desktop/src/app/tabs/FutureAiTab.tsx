import { Bot, CheckCheck, History, ListChecks } from "lucide-react";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";

export function FutureAiTab() {
  return (
    <div className="tool-grid">
      <Panel title="AI Placeholder">
        <div className="empty-state">
          <Bot size={28} />
          <span>AI editing is intentionally not part of v0.1.</span>
        </div>
      </Panel>
      <Panel title="Reserved Behavior">
        <div className="feature-list">
          <span><ListChecks size={16} /> Suggested edits</span>
          <span><CheckCheck size={16} /> Approval queue</span>
          <span><History size={16} /> Restore point before auto-apply</span>
        </div>
        <Toggle label="Auto-accept selected workflows" checked={false} />
      </Panel>
    </div>
  );
}
