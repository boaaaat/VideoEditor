import { useEffect, useRef } from "react";
import type { RenderedPlaybackController } from "../features/playback/useRenderedPlayback";
import { Button } from "./Button";

export function RenderedPlaybackControls({preview, disabled = false}: {preview: RenderedPlaybackController; disabled?: boolean}) {
  if (!("__TAURI_INTERNALS__" in window)) return null;
  return <div className="rendered-playback-controls">
    {preview.enabled ? <Button onClick={preview.useDraft} title="Return to immediate draft playback">Draft</Button> : null}
    {preview.busy ? <Button onClick={preview.cancel}>Cancel render · {Math.round((preview.job?.progress ?? 0) * 100)}%</Button>
      : <Button onClick={() => void preview.render()} disabled={disabled} title="Render the full timeline with export effects and mixed audio. Changes require a new render.">{preview.ready ? "Refresh playback" : "Render playback"}</Button>}
  </div>;
}

export function RenderedPlayback({preview, playing, playheadUs, speedPercent, volumePercent, loop = false, scale = "fit", canvasWidth, onTime, onPlaying}: {
  preview: RenderedPlaybackController; playing: boolean; playheadUs: number; speedPercent: number; volumePercent: number;
  loop?: boolean; scale?: string; canvasWidth?: number; onTime: (timeUs: number) => void; onPlaying: (playing: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const latest = useRef({playheadUs,playing,onTime,onPlaying,loop,preview});
  latest.current = {playheadUs,playing,onTime,onPlaying,loop,preview};
  const durationUs = preview.job?.durationUs ?? 0;
  useEffect(() => { if (playing && !preview.src) onPlaying(false); }, [playing,preview.src,onPlaying]);
  useEffect(() => {
    const video = ref.current;
    if (!video || !preview.src) return;
    video.playbackRate = Math.min(2, Math.max(.25, speedPercent / 100));
    if (Math.abs(video.currentTime - playheadUs / 1e6) > (playing ? .15 : .001)) video.currentTime = Math.max(0, Math.min(durationUs, playheadUs)) / 1e6;
    if (playing) void video.play().catch((error: unknown) => { if (latest.current.playing && error instanceof Error && error.name !== "AbortError") latest.current.preview.fail(error.message); });
    else video.pause();
  }, [durationUs, playheadUs, playing, preview.src, speedPercent]);
  // GainNode retains the editor's 0–200% monitor-volume range without altering the render.
  const audio = useRef<{element: HTMLVideoElement; context: AudioContext; gain: GainNode; closeTimer?: number}>();
  useEffect(() => {
    const video = ref.current;
    if (!video || !preview.src) return;
    if (audio.current?.element !== video) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(video);
      const node = context.createGain();
      source.connect(node); node.connect(context.destination);
      audio.current = {element:video,context,gain:node};
    }
    const graph = audio.current;
    clearTimeout(graph.closeTimer);
    graph.gain.gain.value = Math.max(0, Math.min(2, volumePercent / 100));
    // React's development effect replay must reuse the one source node allowed per element.
    return () => { graph.closeTimer = window.setTimeout(() => { void graph.context.close(); if (audio.current === graph) audio.current = undefined; }, 0); };
  }, [preview.src]);
  useEffect(() => { if (audio.current) audio.current.gain.gain.value = Math.max(0, Math.min(2, volumePercent / 100)); if (playing) void audio.current?.context.resume().catch(() => undefined); }, [volumePercent,playing,preview.src]);
  useEffect(() => {
    if (!playing || !preview.src) return;
    let frame = 0;
    function tick() { const video = ref.current; if (video && !video.seeking && video.readyState >= 2 && !video.paused) latest.current.onTime(Math.min(durationUs, Math.round(video.currentTime * 1e6))); frame = requestAnimationFrame(tick); }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [durationUs,playing,preview.src]);
  return <div className="preview-frame rendered-playback-preview">
    {preview.src ? <video key={preview.src} ref={ref} src={preview.src} crossOrigin="anonymous" playsInline preload="auto" style={scale === "fit" ? undefined : {width:`${(canvasWidth ?? preview.job?.width ?? 1280) * Number(scale) / 100}px`,height:"auto",maxWidth:"none",maxHeight:"none"}}
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.min(durationUs, latest.current.playheadUs) / 1e6; }}
      onEnded={() => { if (loop && durationUs > 0) { onTime(0); const video = ref.current; if (video) { video.currentTime = 0; void video.play().catch(() => onPlaying(false)); } } else { onTime(durationUs); onPlaying(false); } }}
      onError={() => preview.fail("The rendered movie could not be played. Render again or use Draft playback.")} />
      : <div className="rendered-playback-message" role="status">{preview.error ?? (preview.busy ? "Rendering effects and mixed audio…" : "The timeline changed. Render playback to review this version.")}{preview.busy ? <progress value={preview.job?.progress ?? 0} max={1} aria-label="Playback render progress" /> : null}</div>}
    <div className="preview-stats"><span>{preview.ready ? `${preview.job?.width} × ${preview.job?.height} · SDR` : "Rendered playback"}</span><span>{preview.ready ? "Export effects + mixed audio" : preview.busy ? `${Math.round((preview.job?.progress ?? 0) * 100)}%` : "Render required"}</span></div>
  </div>;
}
