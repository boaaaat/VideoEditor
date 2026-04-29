import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Keyboard, RotateCcw, Search } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { eventToShortcut, shortcutDefinitions, shortcutFor, type ShortcutMap } from "../../features/commands/shortcuts";

const shortcutGroups = ["Playback", "Timeline", "Project", "Navigation"] as const;

interface ShortcutsTabProps {
  shortcuts: ShortcutMap;
  onShortcutsChange: (shortcuts: ShortcutMap) => void;
  onResetShortcuts: () => void;
}

export function ShortcutsTab({ shortcuts, onShortcutsChange, onResetShortcuts }: ShortcutsTabProps) {
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const visibleShortcuts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return shortcutDefinitions.filter((shortcut) => {
      if (!normalizedQuery) {
        return true;
      }
      return `${shortcut.command} ${shortcut.group} ${shortcutFor(shortcuts, shortcut.id)}`.toLowerCase().includes(normalizedQuery);
    });
  }, [query, shortcuts]);

  function assignShortcut(shortcutId: string, event: ReactKeyboardEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingId("");
      return;
    }

    const nextKeys = eventToShortcut(event.nativeEvent);
    if (!nextKeys) {
      return;
    }
    onShortcutsChange({
      ...shortcuts,
      [shortcutId]: nextKeys
    });
    setRecordingId("");
  }

  return (
    <div className="shortcuts-workspace">
      <Panel
        title="Shortcuts"
        actions={
          <Button icon={<RotateCcw size={16} />} onClick={onResetShortcuts}>
            Reset
          </Button>
        }
      >
        <div className="shortcut-tools">
          <label className="media-search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shortcuts" />
          </label>
        </div>
        <div className="shortcut-table" role="table" aria-label="Keyboard shortcuts">
          <div className="shortcut-table-header" role="row">
            <span role="columnheader">Command</span>
            <span role="columnheader">Keys</span>
            <span role="columnheader">Status</span>
          </div>
          {shortcutGroups.map((group) => {
            const groupShortcuts = visibleShortcuts.filter((shortcut) => shortcut.group === group);
            if (groupShortcuts.length === 0) {
              return null;
            }
            return (
              <section key={group} className="shortcut-group">
                <h3>{group}</h3>
                {groupShortcuts.map((shortcut) => (
                  <div className="shortcut-row" role="row" key={shortcut.id}>
                    <span role="cell">{shortcut.command}</span>
                    <button
                      type="button"
                      role="cell"
                      className="shortcut-key-button"
                      disabled={!shortcut.editable}
                      onClick={() => setRecordingId(shortcut.id)}
                      onKeyDown={(event) => recordingId === shortcut.id && assignShortcut(shortcut.id, event)}
                    >
                      <kbd>{recordingId === shortcut.id ? "Press keys" : shortcutFor(shortcuts, shortcut.id)}</kbd>
                    </button>
                    <span role="cell" className="shortcut-state">
                      <Keyboard size={14} />
                      {shortcut.editable ? "Editable" : "Locked"}
                    </span>
                  </div>
                ))}
              </section>
            );
          })}
          {visibleShortcuts.length === 0 ? <div className="empty-state">No shortcuts match the search.</div> : null}
        </div>
      </Panel>
    </div>
  );
}
