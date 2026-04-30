import { useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import {
  defaultAudioAdjustment,
  defaultClipEffects,
  defaultClipTransform,
  defaultColorAdjustment,
  type ClipEffect,
  type ProjectSettings,
  type Timeline,
  type TimelineClip
} from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import type { MediaAsset } from "../../features/media/mediaTypes";
import { getMediaSourceUrl } from "../../features/media/mediaTypes";

interface ColorEffectsPlaybackProps {
  timeline: Timeline;
  mediaAssets: MediaAsset[];
  projectSettings: ProjectSettings;
  selectedClipId: string;
  onSelectedClipIdChange: (clipId: string) => void;
  playheadUs: number;
  setPlayheadUs: Dispatch<SetStateAction<number>>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  previewVolumePercent: number;
  previewSpeedPercent: number;
}

export function ColorEffectsPlayback({
  timeline,
  mediaAssets,
  projectSettings,
  selectedClipId,
  onSelectedClipIdChange,
  playheadUs,
  setPlayheadUs,
  playing,
  setPlaying,
  previewVolumePercent,
  previewSpeedPercent
}: ColorEffectsPlaybackProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoClips = useMemo(() => collectVideoClips(timeline), [timeline]);
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId) ?? videoClips[0];
  const selectedAsset = selectedClip ? mediaAssets.find((asset) => asset.id === selectedClip.mediaId) : undefined;
  const [videoSrc, setVideoSrc] = useState("");
  const durationUs = Math.max(timeline.durationUs, 1_000_000);

  useEffect(() => {
    const activeClip = videoClips.find((clip) => playheadUs >= clip.startUs && playheadUs < clip.startUs + getClipDisplayDurationUs(clip));
    if (activeClip && activeClip.id !== selectedClipId) {
      onSelectedClipIdChange(activeClip.id);
    }
  }, [onSelectedClipIdChange, playheadUs, selectedClipId, videoClips]);

  useEffect(() => {
    let cancelled = false;
    setVideoSrc("");
    if (!selectedAsset) {
      return;
    }
    void getMediaSourceUrl(selectedAsset.path).then((url) => {
      if (!cancelled) {
        setVideoSrc(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedAsset]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !selectedClip || !videoSrc) {
      return;
    }
    const mediaTimeSeconds = getClipMediaTimeUs(selectedClip, playheadUs) / 1_000_000;
    if (Math.abs(element.currentTime - mediaTimeSeconds) > 0.18) {
      element.currentTime = mediaTimeSeconds;
    }
    element.playbackRate = effectivePlaybackRate(selectedClip, previewSpeedPercent);
    element.volume = projectSettings.audioEnabled ? Math.min(1, clipLinearGain(selectedClip, projectSettings, previewVolumePercent)) : 0;
    if (playing && isPlayheadInsideClip(selectedClip, playheadUs)) {
      void element.play().catch(() => setPlaying(false));
    } else {
      element.pause();
    }
  }, [playheadUs, playing, previewSpeedPercent, previewVolumePercent, projectSettings, selectedClip, setPlaying, videoSrc]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element || !selectedClip) {
      return;
    }
    function onTimeUpdate() {
      if (!videoRef.current || !selectedClip || !playing) {
        return;
      }
      const sourceOffsetUs = Math.max(0, Math.round(videoRef.current.currentTime * 1_000_000) - selectedClip.inUs);
      const nextPlayheadUs = selectedClip.startUs + Math.round(sourceOffsetUs / getClipSpeedFactor(selectedClip));
      const clipEndUs = selectedClip.startUs + getClipDisplayDurationUs(selectedClip);
      if (nextPlayheadUs >= clipEndUs) {
        setPlaying(false);
        setPlayheadUs(clipEndUs);
        return;
      }
      setPlayheadUs(nextPlayheadUs);
    }
    element.addEventListener("timeupdate", onTimeUpdate);
    return () => element.removeEventListener("timeupdate", onTimeUpdate);
  }, [playing, selectedClip, setPlaying, setPlayheadUs]);

  function togglePlayback() {
    if (!selectedClip) {
      setPlaying(false);
      return;
    }
    if (!isPlayheadInsideClip(selectedClip, playheadUs)) {
      setPlayheadUs(selectedClip.startUs);
    }
    setPlaying((value) => !value);
  }

  function stepFrame(direction: -1 | 1) {
    const frameUs = Math.round(1_000_000 / Math.max(1, projectSettings.fps));
    setPlaying(false);
    setPlayheadUs((current) => clamp(current + direction * frameUs, 0, durationUs));
  }

  function seekTimeline(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    setPlaying(false);
    setPlayheadUs(Math.round(durationUs * ratio));
  }

  const visualStyle = selectedClip ? getClipVisualStyle(selectedClip) : undefined;

  return (
    <div className="editor-playback-surface">
      <div className="editor-playback-preview">
        {videoSrc && selectedClip ? (
          <video ref={videoRef} src={videoSrc} playsInline preload="auto" style={visualStyle} />
        ) : (
          <div className="editor-playback-empty">Select a video clip.</div>
        )}
      </div>
      <div className="editor-playback-controls">
        <div className="transport">
          <IconButton label={playing ? "Pause" : "Play"} icon={playing ? <Pause size={17} /> : <Play size={17} />} onClick={togglePlayback} />
          <IconButton label="Step back one frame" icon={<StepBack size={16} />} onClick={() => stepFrame(-1)} />
          <IconButton label="Step forward one frame" icon={<StepForward size={16} />} onClick={() => stepFrame(1)} />
          <span className="timeline-timecode">{formatSeconds(playheadUs)}</span>
        </div>
        <div className="editor-playback-meta">
          <span>{selectedAsset?.name ?? "No video selected"}</span>
          {selectedClip ? <Button onClick={() => setPlayheadUs(selectedClip.startUs)}>Jump to Clip</Button> : null}
        </div>
        <div className="editor-mini-timeline" onClick={seekTimeline}>
          {videoClips.map((clip) => {
            const asset = mediaAssets.find((item) => item.id === clip.mediaId);
            return (
              <span
                key={clip.id}
                className={clip.id === selectedClip?.id ? "editor-mini-clip selected" : "editor-mini-clip"}
                title={asset?.name ?? clip.id}
                style={{
                  left: `${(clip.startUs / durationUs) * 100}%`,
                  width: `${Math.max(0.5, (getClipDisplayDurationUs(clip) / durationUs) * 100)}%`
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectedClipIdChange(clip.id);
                  setPlayheadUs(clip.startUs);
                }}
              />
            );
          })}
          <span className="editor-mini-playhead" style={{ left: `${(clamp(playheadUs, 0, durationUs) / durationUs) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}

function collectVideoClips(timeline: Timeline) {
  return timeline.tracks.flatMap((track) => track.kind === "video" && track.visible ? track.clips : []);
}

function normalizeClipSpeedPercent(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? clamp(Math.round(numeric), 25, 400) : 100;
}

function getClipSpeedFactor(clip: TimelineClip) {
  return normalizeClipSpeedPercent(clip.speedPercent) / 100;
}

function getClipDisplayDurationUs(clip: TimelineClip) {
  const sourceDurationUs = Math.max(0, clip.outUs - clip.inUs);
  return sourceDurationUs > 0 ? Math.max(1, Math.round(sourceDurationUs / getClipSpeedFactor(clip))) : 0;
}

function getClipMediaTimeUs(clip: TimelineClip, playheadUs: number) {
  const sourceOffsetUs = Math.round(Math.max(0, playheadUs - clip.startUs) * getClipSpeedFactor(clip));
  return clamp(sourceOffsetUs + clip.inUs, clip.inUs, Math.max(clip.inUs, clip.outUs - 1));
}

function effectivePlaybackRate(clip: TimelineClip, previewSpeedPercent: number) {
  return clamp(getClipSpeedFactor(clip) * (clamp(previewSpeedPercent, 25, 200) / 100), 0.1, 8);
}

function isPlayheadInsideClip(clip: TimelineClip, playheadUs: number) {
  return playheadUs >= clip.startUs && playheadUs < clip.startUs + getClipDisplayDurationUs(clip);
}

function clipLinearGain(clip: TimelineClip, projectSettings: ProjectSettings, previewVolumePercent: number) {
  const audio = { ...defaultAudioAdjustment, ...clip.audio };
  if (audio.muted) {
    return 0;
  }
  return Math.pow(10, ((projectSettings.masterGainDb ?? 0) + audio.gainDb) / 20) * clamp(previewVolumePercent / 100, 0, 2);
}

function getClipVisualStyle(clip: TimelineClip) {
  const transform = { ...defaultClipTransform, ...clip.transform };
  const style: CSSProperties = {
    filter: buildCssFilter(clip),
    transform: `translate(${transform.positionX}px, ${transform.positionY}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
    opacity: clamp(transform.opacity, 0, 1)
  };
  return style;
}

function buildCssFilter(clip: TimelineClip) {
  const color = { ...defaultColorAdjustment, ...clip.color };
  const effects = normalizeEffects(clip.effects);
  const filters = [
    `brightness(${Math.max(0, 1 + color.brightness / 100)})`,
    `contrast(${Math.max(0, 1 + color.contrast / 100)})`,
    `saturate(${Math.max(0, color.saturation)})`
  ];
  if (color.temperature || color.tint) {
    filters.push(`hue-rotate(${(color.tint + color.temperature * 0.35).toFixed(1)}deg)`);
  }
  for (const effect of effects) {
    if (!effect.enabled || effect.amount <= 0) {
      continue;
    }
    if (effect.type === "blur") {
      filters.push(`blur(${(effect.amount / 12).toFixed(2)}px)`);
    } else if (effect.type === "grayscale") {
      filters.push(`grayscale(${Math.min(1, effect.amount / 100)})`);
    } else if (effect.type === "vignette") {
      filters.push(`drop-shadow(0 0 ${(effect.amount / 2).toFixed(0)}px rgba(0,0,0,0.55))`);
    }
  }
  return filters.join(" ");
}

function normalizeEffects(value?: ClipEffect[]) {
  const existingById = new Map((value ?? []).map((effect) => [effect.id, effect]));
  return defaultClipEffects.map((effect) => ({
    ...effect,
    ...existingById.get(effect.id)
  }));
}

function formatSeconds(valueUs: number) {
  return `${(valueUs / 1_000_000).toFixed(2)}s`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
