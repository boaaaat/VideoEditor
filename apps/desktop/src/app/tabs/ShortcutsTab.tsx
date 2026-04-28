import { Keyboard } from "lucide-react";
import { Panel } from "../../components/Panel";
import { shortcutDefinitions } from "../../features/commands/shortcuts";

const shortcutGroups = ["Playback", "Timeline", "Project", "Navigation"] as const;

export function ShortcutsTab() {
  return (
    <div className="shortcuts-workspace">
      <Panel title="Shortcuts">
        <div className="shortcut-table" role="table" aria-label="Keyboard shortcuts">
          <div className="shortcut-table-header" role="row">
            <span role="columnheader">Command</span>
            <span role="columnheader">Keys</span>
            <span role="columnheader">Status</span>
          </div>
          {shortcutGroups.map((group) => (
            <section key={group} className="shortcut-group">
              <h3>{group}</h3>
              {shortcutDefinitions
                .filter((shortcut) => shortcut.group === group)
                .map((shortcut) => (
                  <div className="shortcut-row" role="row" key={shortcut.id}>
                    <span role="cell">{shortcut.command}</span>
                    <kbd role="cell">{shortcut.keys}</kbd>
                    <span role="cell" className="shortcut-state">
                      <Keyboard size={14} />
                      {shortcut.editable ? "Editable" : "Locked"}
                    </span>
                  </div>
                ))}
            </section>
          ))}
        </div>
      </Panel>
    </div>
  );
}
