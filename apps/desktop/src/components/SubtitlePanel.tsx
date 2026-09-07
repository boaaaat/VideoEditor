import { useMemo, useRef, useState } from "react";
import { Download, FileUp } from "lucide-react";
import { parseSubtitles, serializeSubtitles, type EditorCommand, type ParsedSubtitles, type SubtitleFormat, type TitleOverlay } from "@ai-video-editor/protocol";
import { Button } from "./Button";
import { NumberField } from "./NumberField";

export function SubtitlePanel({ titles, onCommand, onImported, onBusyChange }: { titles: TitleOverlay[]; onCommand: (command: EditorCommand) => Promise<void>; onImported: () => void; onBusyChange: (busy: boolean) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<{name: string; content: string; format: SubtitleFormat} | null>(null);
  const [offsetUs, setOffsetUs] = useState(0);
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const count = titles.filter((title) => title.kind === "caption").length;
  const {parsed, parseError} = useMemo<{parsed?: ParsedSubtitles; parseError?: string}>(() => {
    if (!source) return {};
    try { return {parsed: parseSubtitles(source.content, source.format, offsetUs)}; }
    catch (error) { return {parseError: error instanceof Error ? error.message : String(error)}; }
  }, [source, offsetUs]);
  async function action(run: () => Promise<void>) {
    setBusy(true); onBusyChange(true); setError(""); setMessage("");
    try { await run(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); onBusyChange(false); }
  }
  async function save(format: SubtitleFormat) {
    await action(async () => {
      const result = serializeSubtitles(titles, format);
      if ("__TAURI_INTERNALS__" in window) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({ title: "Export captions", defaultPath: `captions.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
        if (!path) return;
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("save_subtitle_file", { path, content: result.content, overwrite: true });
      } else {
        const url = URL.createObjectURL(new Blob([result.content], {type: "text/plain;charset=utf-8"}));
        const link = document.createElement("a"); link.href = url; link.download = `captions.${format}`; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setMessage(`Exported ${result.count} captions as ${format.toUpperCase()}.`);
    });
  }
  return <details className="subtitle-tools">
    <summary>Import / export subtitles <span className="muted">· {count} captions</span></summary>
    <div className="control-stack">
      <p className="muted-line">Import UTF-8 SRT or WebVTT files as editable captions. Subtitle exports include caption text and timing; video exports render their appearance.</p>
      <input ref={picker} type="file" hidden accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (!file) return;
        setSource(null);
        void action(async () => {
          if (file.size > 2 * 1024 * 1024) throw new Error("Choose a subtitle file no larger than 2 MB");
          if (!/\.(srt|vtt)$/i.test(file.name)) throw new Error("Choose an SRT or WebVTT file");
          setSource({name:file.name,content:await file.text(),format:/\.vtt$/i.test(file.name) ? "vtt" : "srt"});
        });
      }} />
      <div className="export-actions"><Button disabled={busy} icon={<FileUp size={16} />} onClick={() => picker.current?.click()}>Choose subtitle file</Button><Button disabled={busy || !count} icon={<Download size={16} />} onClick={() => void save("srt")}>Export SRT</Button><Button disabled={busy || !count} onClick={() => void save("vtt")}>Export WebVTT</Button></div>
      {source ? <fieldset disabled={busy} className="inspector-fields"><strong>{source.name}</strong><div className="title-field-grid"><NumberField label="Timing offset · seconds" value={offsetUs / 1_000_000} min={-86400} max={86400} step={0.1} onCommit={(value) => setOffsetUs(Math.round(value * 1_000_000))} /><label>Import mode<select value={mode} onChange={(event) => setMode(event.target.value as "append" | "replace")}><option value="append">Add to existing captions</option><option value="replace">Replace existing captions</option></select></label></div>{mode === "replace" && count ? <p className="muted-line">Replaces {count} existing captions. Ordinary titles remain. Undo restores the previous captions.</p> : null}{parsed ? <><p>{parsed.cues.length} captions ready · {(parsed.cues[0].startUs / 1_000_000).toFixed(2)}s to {(Math.max(...parsed.cues.map((cue) => cue.startUs + cue.durationUs)) / 1_000_000).toFixed(2)}s</p>{parsed.warnings.map((warning) => <p className="muted-line" key={warning}>{warning}</p>)}<pre className="subtitle-sample">{parsed.cues.slice(0, 3).map((cue) => cue.text).join("\n\n")}</pre></> : null}<Button variant="primary" disabled={!parsed || busy} onClick={() => void action(async () => {if (!parsed) return; await onCommand({type:"import_captions",captions:parsed.cues,mode}); setMessage(`Imported ${parsed.cues.length} captions as one undo step.`); setSource(null); onImported();})}>Import {parsed?.cues.length ?? ""} captions</Button></fieldset> : null}
      {error || parseError ? <p role="alert" className="error-message">{error || parseError}</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </div>
  </details>;
}
