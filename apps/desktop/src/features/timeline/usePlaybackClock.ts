import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/** Follow decoded media while it is advancing; keep gaps, stills and unavailable codecs moving. */
export function usePlaybackClock({ playing, playheadUs, clipId, durationUs, speedPercent, loop = false, setPlaying, setPlayheadUs }: {
  playing: boolean; playheadUs: number; clipId: string; durationUs: number; speedPercent: number; loop?: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>; setPlayheadUs: Dispatch<SetStateAction<number>>;
}) {
  const latest = useRef({ playing, clipId, durationUs, loop });
  latest.current = { playing, clipId, durationUs, loop };
  const lastMediaTick = useRef(0);
  const lastFrame = useRef(0);
  const publish = useCallback((timeUs: number) => {
    const state = latest.current;
    if (!state.playing) return;
    const end = Math.max(1, state.durationUs);
    if (timeUs >= end) {
      setPlayheadUs(state.loop ? 0 : end);
      if (!state.loop) setPlaying(false);
    } else setPlayheadUs(Math.max(0, Math.round(timeUs)));
  }, [setPlaying, setPlayheadUs]);
  const onPlaybackClock = useCallback((sourceClipId: string, timeUs: number) => {
    if (sourceClipId !== latest.current.clipId || !latest.current.playing) return;
    lastMediaTick.current = performance.now();
    lastFrame.current = lastMediaTick.current;
    publish(timeUs);
  }, [publish]);
  const onPlaybackClockUnavailable = useCallback((sourceClipId: string) => {
    if (sourceClipId === latest.current.clipId) lastMediaTick.current = -Infinity;
  }, []);
  useEffect(() => {
    if (playing && playheadUs >= durationUs) publish(playheadUs);
  }, [durationUs, playheadUs, playing, publish]);
  useEffect(() => {
    if (!playing) return;
    lastFrame.current = performance.now();
    lastMediaTick.current = clipId ? lastFrame.current : -Infinity;
    let frame = 0;
    function tick(now: number) {
      const elapsed = Math.min(100, Math.max(0, now - lastFrame.current));
      lastFrame.current = now;
      if (!latest.current.clipId || now - lastMediaTick.current > 500) {
        setPlayheadUs((current) => {
          const next = current + Math.round(elapsed * 1000 * Math.min(2, Math.max(.25, speedPercent / 100)));
          return Math.min(next, Math.max(1, latest.current.durationUs));
        });
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [clipId, playing, setPlayheadUs, speedPercent]);
  return { onPlaybackClock, onPlaybackClockUnavailable };
}
