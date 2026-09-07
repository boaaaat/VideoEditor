import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { EditorCommand, TitleOverlay } from "@ai-video-editor/protocol";
import { Button } from "./Button";
import { NumberField } from "./NumberField";
import { Toggle } from "./Toggle";
import { SubtitlePanel } from "./SubtitlePanel";

export function TitlePanel({ titles, selectedId, playheadUs, onCommand, onSeek }: {
  titles: TitleOverlay[]; selectedId: string; playheadUs: number;
  onCommand: (command: EditorCommand) => Promise<void>; onSeek: (timeUs: number) => void;
}) {
  const fresh = (): TitleOverlay => ({ id: "", kind: "title", text: "Your title", startUs: playheadUs, durationUs: 3_000_000, fontSize: 48, color: "#ffffff", positionX: 50, positionY: 80, background: true });
  const [id, setId] = useState(selectedId);
  const [draft, setDraft] = useState<TitleOverlay>(() => titles.find((title) => title.id === selectedId) ?? fresh());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = titles.find((title) => title.id === id);
  useEffect(() => { if (selected) setDraft(selected); }, [selected]);
  function update(patch: Partial<TitleOverlay>) { setDraft((current) => ({ ...current, ...patch })); }
  async function save() {
    setBusy(true);
    setError("");
    const titleId = id || crypto.randomUUID();
    const { id: _id, ...values } = draft;
    try {
      await onCommand({ type: id ? "update_title" : "add_title", titleId, ...values });
      setId(titleId);
      onSeek(draft.startUs);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  }
  return <div className="control-stack title-editor">
    <p className="muted">Titles and captions appear above the video tracks. Enter line breaks for multiple lines.</p>
    <fieldset disabled={busy} className="inspector-fields"><SubtitlePanel titles={titles} onCommand={onCommand} onBusyChange={setBusy} onImported={() => { setId(""); setDraft(fresh()); }} /></fieldset>
    <div className="title-selector-row"><select aria-label="Select title" value={id} disabled={busy} onChange={(event) => { setId(event.target.value); if (!event.target.value) setDraft(fresh()); }}><option value="">New title</option>{titles.map((title) => <option key={title.id} value={title.id}>{title.text.replace(/\n/g, " ").slice(0, 60)}</option>)}</select><Button icon={<Plus size={16} />} disabled={busy} onClick={() => { setId(""); setDraft(fresh()); }}>New</Button></div>
    <fieldset disabled={busy} className="inspector-fields">
      <label>Overlay type<select value={draft.kind ?? "title"} onChange={(event) => update({kind: event.target.value as "title" | "caption"})}><option value="title">Title</option><option value="caption">Caption · included in subtitle exports</option></select></label>
      <label>Text<textarea rows={4} maxLength={4000} value={draft.text} onChange={(event) => update({ text: event.target.value })} /></label>
      {new TextEncoder().encode(draft.text).length > 4000 ? <p className="error-message">Text exceeds the 4,000-byte limit. Shorten this caption or split it into separate cues.</p> : null}
      <div className="title-field-grid">
        <NumberField label="Start · seconds" value={draft.startUs / 1_000_000} min={0} step={0.01} onCommit={(value) => update({ startUs: Math.round(value * 1_000_000) })} />
        <NumberField label="Duration · seconds" value={draft.durationUs / 1_000_000} min={0.01} step={0.1} onCommit={(value) => update({ durationUs: Math.round(value * 1_000_000) })} />
        <NumberField label="Font size · pixels" value={draft.fontSize} min={10} max={300} onCommit={(value) => update({ fontSize: Math.round(value) })} />
        <label>Text color<input type="color" value={draft.color} onChange={(event) => update({ color: event.target.value })} /></label>
        <NumberField label="Horizontal position · %" value={draft.positionX} min={0} max={100} onCommit={(value) => update({ positionX: value })} />
        <NumberField label="Vertical position · %" value={draft.positionY} min={0} max={100} onCommit={(value) => update({ positionY: value })} />
      </div>
      <div className="title-presets"><Button onClick={() => update({ positionX: 50, positionY: 50 })}>Centered</Button><Button onClick={() => update({ positionX: 50, positionY: 80 })}>Lower third</Button><Button onClick={() => update({ kind: "caption", fontSize: 36, positionX: 50, positionY: 92 })}>Caption</Button></div>
      <Toggle label="Readable background" checked={draft.background} onChange={(event) => update({ background: event.target.checked })} />
    </fieldset>
    {error ? <p role="alert" className="error-message">{error}</p> : null}
    <div className="title-selector-row"><Button variant="primary" disabled={busy || !draft.text.trim() || new TextEncoder().encode(draft.text).length > 4000} onClick={() => void save()}>{id ? "Save" : "Add"} {draft.kind === "caption" ? "caption" : "title"}</Button>{id ? <Button disabled={busy} icon={<Trash2 size={16} />} onClick={async () => { setBusy(true); setError(""); try { await onCommand({ type: "delete_title", titleId: id }); setId(""); setDraft(fresh()); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>Delete</Button> : null}</div>
  </div>;
}
