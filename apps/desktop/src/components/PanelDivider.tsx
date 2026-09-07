import type { PointerEvent } from "react";

export function PanelDivider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  function drag(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (bounds) onChange(Math.min(75, Math.max(30, (event.clientY - bounds.top) / bounds.height * 100)));
  }
  return <div className="panel-divider" role="separator" tabIndex={0} aria-label="Resize preview and timeline" aria-orientation="horizontal" aria-valuemin={30} aria-valuemax={75} aria-valuenow={Math.round(value)}
    title="Drag to resize · double-click to reset"
    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
    onPointerMove={drag} onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); }}
    onDoubleClick={() => onChange(56)}
    onKeyDown={(event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); onChange(Math.min(75, Math.max(30, value + (event.key === "ArrowUp" ? -2 : 2)))); }
      if (event.key === "Home") { event.preventDefault(); onChange(56); }
    }} />;
}
