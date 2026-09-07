import { useEffect, useRef, useState } from "react";
import { compositionPlaybackParams, renderCompositionPlayback, type CompositionPlaybackInput, type CompositionPlaybackJob } from "./composition";
import { getMediaSourceUrl } from "../media/mediaTypes";

export function useRenderedPlayback(input: CompositionPlaybackInput, setPlaying: (playing: boolean) => void) {
  const key = JSON.stringify(compositionPlaybackParams(input));
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<{key: string; job?: CompositionPlaybackJob; src?: string; error?: string}>();
  const request = useRef<AbortController>();
  const current = result?.key === key ? result : undefined;
  const busy = current?.job?.state === "queued" || current?.job?.state === "rendering";
  const ready = Boolean(current?.src);
  useEffect(() => () => { request.current?.abort(); }, [key]);
  useEffect(() => { if (enabled && !ready) setPlaying(false); }, [enabled, ready, key, setPlaying]);

  async function render() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setEnabled(true); setPlaying(false);
    setResult({key,job:{jobId:"",state:"queued",progress:0}});
    try {
      const job = await renderCompositionPlayback(input, controller.signal, (progress) => { if (!controller.signal.aborted) setResult({key,job:progress}); });
      if (!job.path) throw new Error("The renderer returned no playback file");
      const src = await getMediaSourceUrl(job.path);
      if (!controller.signal.aborted) setResult({key,job,src});
    } catch (error) { if (!controller.signal.aborted) setResult({key,error:error instanceof Error ? error.message : String(error)}); }
  }
  function cancel() { request.current?.abort(); setResult(undefined); setPlaying(false); }
  function useDraft() { cancel(); setEnabled(false); }
  function fail(error: string) { setPlaying(false); setResult({key,error}); }
  return {enabled, busy, ready, job:current?.job, src:current?.src, error:current?.error, render, cancel, useDraft, fail};
}
export type RenderedPlaybackController = ReturnType<typeof useRenderedPlayback>;
