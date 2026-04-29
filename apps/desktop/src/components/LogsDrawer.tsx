import { useEffect, useRef } from "react";
import { Copy, FileDown, Trash2, X } from "lucide-react";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import type { AppLogEntry } from "../features/logging/appLog";
import { formatAppLogEntry } from "../features/logging/appLog";

interface LogsDrawerProps {
  open: boolean;
  logs: AppLogEntry[];
  onClose: () => void;
  onClear: () => void;
  onCopy: () => void;
  onExport: () => void;
}

export function LogsDrawer({ open, logs, onClose, onClear, onCopy, onExport }: LogsDrawerProps) {
  const logListRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    const list = logListRef.current;
    if (!open || !list || !wasNearBottomRef.current) {
      return;
    }

    list.scrollTop = list.scrollHeight;
  }, [logs, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="logs-drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="logs-drawer" role="dialog" aria-modal="true" aria-label="Application logs" onMouseDown={(event) => event.stopPropagation()}>
        <header className="logs-drawer-header">
          <div>
            <h2>Application Logs</h2>
            <span>{logs.length} entr{logs.length === 1 ? "y" : "ies"}</span>
          </div>
          <div className="logs-drawer-actions">
            <Button icon={<Copy size={15} />} onClick={onCopy}>
              Copy
            </Button>
            <Button icon={<FileDown size={15} />} onClick={onExport}>
              Export
            </Button>
            <Button icon={<Trash2 size={15} />} variant="danger" onClick={onClear}>
              Clear
            </Button>
            <IconButton label="Close logs" icon={<X size={18} />} onClick={onClose} />
          </div>
        </header>
        <div
          ref={logListRef}
          className="logs-drawer-list"
          onScroll={(event) => {
            const element = event.currentTarget;
            wasNearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
          }}
        >
          {logs.length > 0 ? (
            logs.map((entry) => (
              <article key={entry.id} className={`log-entry log-entry-${entry.level}`}>
                <time>{formatLogTime(entry.timestamp)}</time>
                <span className="log-entry-level">{entry.level}</span>
                <span className="log-entry-source">{entry.source}</span>
                <p>{entry.message}</p>
                {entry.details ? <pre>{JSON.stringify(entry.details, null, 2)}</pre> : null}
              </article>
            ))
          ) : (
            <div className="logs-empty">No logs yet.</div>
          )}
        </div>
      </aside>
    </div>
  );
}

export function logsToText(logs: AppLogEntry[]) {
  return logs.map(formatAppLogEntry).join("\n");
}

function formatLogTime(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
