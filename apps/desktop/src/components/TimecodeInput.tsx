import { useEffect, useState } from "react";

export function formatTimecode(timeUs: number, fps: number) {
  const rate = Math.max(1, Math.round(fps));
  const totalFrames = Math.max(0, Math.round(timeUs * fps / 1_000_000));
  const frames = totalFrames % rate;
  const seconds = Math.floor(totalFrames / rate);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, frames]
    .map((part) => String(part).padStart(2, "0")).join(":");
}

export function TimecodeInput({ valueUs, fps, maxUs, onSeek }: {
  valueUs: number; fps: number; maxUs: number; onSeek: (timeUs: number) => void;
}) {
  const formatted = formatTimecode(valueUs, fps);
  const [draft, setDraft] = useState(formatted);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(formatted); }, [formatted, editing]);
  function commit() {
    let timeUs = NaN;
    const parts = draft.trim().split(":");
    if (parts.length === 1 && /^\d+(\.\d+)?$/.test(draft.trim())) timeUs = Number(draft) * 1_000_000;
    if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
      const [hours, minutes, seconds, frames] = parts.map(Number);
      if (minutes < 60 && seconds < 60 && frames < Math.round(fps)) {
        timeUs = (((hours * 3600 + minutes * 60 + seconds) * Math.round(fps) + frames) / fps) * 1_000_000;
      }
    }
    if (Number.isFinite(timeUs)) onSeek(Math.round(Math.max(0, Math.min(maxUs, timeUs))));
    setDraft(formatted);
    setEditing(false);
  }
  return <input className="timecode-input" aria-label="Playhead timecode" title="Enter HH:MM:SS:FF or seconds, then Enter to seek"
    value={draft} spellCheck={false} onFocus={() => setEditing(true)} onChange={(event) => setDraft(event.target.value)}
    onBlur={commit} onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") { setDraft(formatted); setEditing(false); event.stopPropagation(); }
    }} />;
}
