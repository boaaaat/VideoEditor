import { useState } from "react";
import { Flag, Trash2 } from "lucide-react";
import type { EditorCommand, TimelineMarker } from "@ai-video-editor/protocol";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { NumberField } from "./NumberField";

export function MarkerPanel({ markers, playheadUs, onSeek, onCommand }: {
  markers: TimelineMarker[];
  playheadUs: number;
  onSeek: (timeUs: number) => void;
  onCommand: (command: EditorCommand) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function edit(command: EditorCommand) {
    if (busy) return;
    setBusy(true);
    try { await onCommand(command); } finally { setBusy(false); }
  }
  return <div className="control-stack">
    <p className="muted">Mark ideas, beats, or review notes. Click a flag to jump there. M adds a marker; Shift + Up / Down visits markers.</p>
    <Button disabled={busy} icon={<Flag size={16} />} onClick={() => void edit({ type: "add_marker", timeUs: playheadUs, name: `Marker ${markers.length + 1}` })}>Add at playhead</Button>
    {!markers.length ? <div className="empty-state">No markers yet.</div> : null}
    {markers.map((marker) => <div className="marker-row" key={marker.id}>
      <IconButton label={`Go to ${marker.name}`} icon={<Flag size={17} color={marker.color} />} onClick={() => onSeek(marker.timeUs)} />
      <label>Name<input key={marker.name} aria-label="Marker name" maxLength={200} defaultValue={marker.name} disabled={busy} onBlur={(event) => {
        const name = event.currentTarget.value.trim() || marker.name;
        event.currentTarget.value = name;
        if (name !== marker.name) void edit({ type: "update_marker", markerId: marker.id, name });
      }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
      <NumberField label="Seconds" value={marker.timeUs / 1_000_000} min={0} step={0.001} disabled={busy} onCommit={(value) => void edit({ type: "update_marker", markerId: marker.id, timeUs: Math.round(value * 1_000_000) })} />
      <label>Color<input aria-label="Marker color" type="color" value={marker.color} disabled={busy} onChange={(event) => void edit({ type: "update_marker", markerId: marker.id, color: event.target.value })} /></label>
      <IconButton label={`Delete ${marker.name}`} disabled={busy} icon={<Trash2 size={16} />} onClick={() => void edit({ type: "delete_marker", markerId: marker.id })} />
    </div>)}
  </div>;
}
