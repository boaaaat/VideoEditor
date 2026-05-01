import { useEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import { Headphones, Mic2, Pause, Play, RotateCcw, Wand2 } from "lucide-react";
import type { AudioAdjustment, ProjectSettings, Timeline, TimelineClip } from "@ai-video-editor/protocol";
import { defaultAudioAdjustment } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";
import { Toggle } from "../../components/Toggle";
import { executeCommand } from "../../features/commands/commandClient";
import type { LogStatus } from "../../features/logging/appLog";
import type { MediaAsset } from "../../features/media/mediaTypes";
import { getMediaSourceUrl, getMediaWaveformDataUrl } from "../../features/media/mediaTypes";

interface AudioTabProps {
  timeline: Timeline;
  setTimeline: Dispatch<SetStateAction<Timeline>>;
  mediaAssets: MediaAsset[];
  projectSettings: ProjectSettings;
  playheadUs: number;
  setPlayheadUs: Dispatch<SetStateAction<number>>;
  playing: boolean;
  setPlaying: Dispatch<SetStateAction<boolean>>;
  previewVolumePercent: number;
  previewSpeedPercent: number;
  onProjectSettingsChange: (settings: ProjectSettings) => void;
  setStatusMessage: LogStatus;
}

interface AudioClipRow {
  clip: TimelineClip;
  trackName: string;
  asset?: MediaAsset;
}

export function AudioTab({
  timeline,
  setTimeline,
  mediaAssets,
  projectSettings,
  playheadUs,
  setPlayheadUs,
  playing,
  setPlaying,
  previewVolumePercent,
  previewSpeedPercent,
  onProjectSettingsChange,
  setStatusMessage
}: AudioTabProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioClips = useMemo(() => collectAudioClips(timeline, mediaAssets), [mediaAssets, timeline]);
  const [selectedClipId, setSelectedClipId] = useState("");
  const selectedRow = audioClips.find((row) => row.clip.id === selectedClipId) ?? audioClips[0];
  const selectedClip = selectedRow?.clip;
  const selectedAsset = selectedRow?.asset;
  const clipAudio = normalizeAudioAdjustment(selectedClip?.audio);
  const [waveformSrc, setWaveformSrc] = useState("");
  const [audioSrc, setAudioSrc] = useState("");

  useEffect(() => {
    if (!selectedClipId && audioClips[0]) {
      setSelectedClipId(audioClips[0].clip.id);
    } else if (selectedClipId && !audioClips.some((row) => row.clip.id === selectedClipId)) {
      setSelectedClipId(audioClips[0]?.clip.id ?? "");
    }
  }, [audioClips, selectedClipId]);

  useEffect(() => {
    let cancelled = false;
    setWaveformSrc("");
    if (!selectedAsset || !selectedClip) {
      return;
    }

    const durationUs = Math.max(1, selectedClip.outUs - selectedClip.inUs);
    void getMediaWaveformDataUrl(selectedAsset, selectedClip.inUs, durationUs).then((url) => {
      if (!cancelled) {
        setWaveformSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAsset, selectedClip]);

  useEffect(() => {
    let cancelled = false;
    setAudioSrc("");
    if (!selectedAsset) {
      return;
    }
    void getMediaSourceUrl(selectedAsset.path).then((url) => {
      if (!cancelled) {
        setAudioSrc(url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selectedAsset]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !selectedClip || !audioSrc) {
      return;
    }
    const mediaTimeSeconds = getClipMediaTimeUs(selectedClip, playheadUs) / 1_000_000;
    if (Math.abs(element.currentTime - mediaTimeSeconds) > 0.18) {
      element.currentTime = mediaTimeSeconds;
    }
    element.playbackRate = effectivePlaybackRate(selectedClip, previewSpeedPercent);
    element.volume = projectSettings.audioEnabled && !clipAudio.muted ? Math.min(1, dbToLinear((projectSettings.masterGainDb ?? 0) + clipAudio.gainDb) * (previewVolumePercent / 100)) : 0;
    if (playing) {
      void element.play().catch(() => setPlaying(false));
    } else {
      element.pause();
    }
  }, [audioSrc, clipAudio.gainDb, clipAudio.muted, playheadUs, playing, previewSpeedPercent, previewVolumePercent, projectSettings.audioEnabled, projectSettings.masterGainDb, selectedClip, setPlaying]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || !selectedClip) {
      return;
    }
    function onTimeUpdate() {
      if (!selectedClip || !audioRef.current || !playing) {
        return;
      }
      const sourceOffsetUs = Math.max(0, Math.round(audioRef.current.currentTime * 1_000_000) - selectedClip.inUs);
      setPlayheadUs(selectedClip.startUs + Math.round(sourceOffsetUs / getClipSpeedFactor(selectedClip)));
    }
    element.addEventListener("timeupdate", onTimeUpdate);
    return () => element.removeEventListener("timeupdate", onTimeUpdate);
  }, [playing, selectedClip, setPlayheadUs]);

  function seekWaveform(event: ReactMouseEvent<HTMLDivElement>) {
    if (!selectedClip) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const nextPlayheadUs = selectedClip.startUs + Math.round(getClipDisplayDurationUs(selectedClip) * ratio);
    setPlaying(false);
    setPlayheadUs(nextPlayheadUs);
  }

  function updateSelectedClipAudio(next: Partial<AudioAdjustment>, label: string) {
    if (!selectedClip) {
      setStatusMessage("Select an audio clip first", { level: "warning" });
      return;
    }

    void executeCommand({ type: "apply_audio_adjustment", clipId: selectedClip.id, adjustment: next }).then((result) => {
      const nextTimeline = (result.data as { timeline?: Timeline } | undefined)?.timeline;
      if (result.ok && nextTimeline?.tracks) {
        setTimeline(nextTimeline);
        setStatusMessage(label, { details: { clipId: selectedClip.id, adjustment: next } });
      } else {
        setStatusMessage(result.error ?? "Audio adjustment failed", { level: "error", details: { clipId: selectedClip.id } });
      }
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : "Audio adjustment failed", { level: "error", details: { clipId: selectedClip.id } });
    });
  }

  function updateProjectAudio(next: Partial<ProjectSettings>, label: string) {
    onProjectSettingsChange({
      ...projectSettings,
      ...next
    });
    setStatusMessage(label, { source: "project", details: next });
  }

  function resetSelectedClipAudio() {
    updateSelectedClipAudio(defaultAudioAdjustment, "Reset clip audio settings");
  }

  return (
    <div className="tool-grid">
      <Panel title="Waveform">
        <div className="audio-clip-picker">
          <label>
            Clip
            <select value={selectedRow?.clip.id ?? ""} onChange={(event) => setSelectedClipId(event.target.value)} disabled={audioClips.length === 0}>
              {audioClips.length === 0 ? <option value="">No audio clips</option> : null}
              {audioClips.map((row) => (
                <option key={row.clip.id} value={row.clip.id}>
                  {row.asset?.name ?? row.clip.mediaId} - {row.trackName}
                </option>
              ))}
            </select>
          </label>
          <span>{selectedClip ? formatClipRange(selectedClip) : "Add audio-capable media to the timeline."}</span>
        </div>
        <div className="audio-playback-controls">
          <Button icon={playing ? <Pause size={16} /> : <Play size={16} />} onClick={() => setPlaying((value) => !value)} disabled={!selectedClip || !audioSrc}>
            {playing ? "Pause" : "Play"}
          </Button>
          <span>{selectedClip ? formatSeconds(playheadUs) : "0.00s"}</span>
        </div>
        <div className="waveform-preview waveform-preview-large seekable" onClick={seekWaveform}>
          {waveformSrc ? <img src={waveformSrc} alt="" /> : <FallbackWaveform />}
          {selectedClip ? <span className="audio-waveform-playhead" style={{ left: `${Math.min(100, Math.max(0, ((playheadUs - selectedClip.startUs) / Math.max(1, getClipDisplayDurationUs(selectedClip))) * 100))}%` }} /> : null}
        </div>
        <audio ref={audioRef} src={audioSrc} preload="auto" />
      </Panel>

      <Panel title="Clip Processing">
        <div className="control-stack">
          <Slider label="Gain" value={clipAudio.gainDb} min={-24} max={12} step={1} onChange={(event) => {
            const value = Number(event.target.value);
            updateSelectedClipAudio({ gainDb: value }, `Clip gain ${value} dB`);
          }} />
          <label>
            Fade in
            <input
              type="number"
              min={0}
              step={0.1}
              value={formatSecondsInput(clipAudio.fadeInUs)}
              onChange={(event) => updateSelectedClipAudio({ fadeInUs: secondsToUs(event.target.valueAsNumber) }, "Clip fade in changed")}
            />
          </label>
          <label>
            Fade out
            <input
              type="number"
              min={0}
              step={0.1}
              value={formatSecondsInput(clipAudio.fadeOutUs)}
              onChange={(event) => updateSelectedClipAudio({ fadeOutUs: secondsToUs(event.target.valueAsNumber) }, "Clip fade out changed")}
            />
          </label>
          <Toggle label="Mute clip" checked={clipAudio.muted} onChange={(event) => updateSelectedClipAudio({ muted: event.target.checked }, event.target.checked ? "Clip muted" : "Clip unmuted")} />
          <Toggle label="Normalize clip" checked={clipAudio.normalize} onChange={(event) => updateSelectedClipAudio({ normalize: event.target.checked }, event.target.checked ? "Clip normalization on" : "Clip normalization off")} />
          <Toggle label="Cleanup clip" checked={clipAudio.cleanup} onChange={(event) => updateSelectedClipAudio({ cleanup: event.target.checked }, event.target.checked ? "Clip cleanup on" : "Clip cleanup off")} />
        </div>
        <div className="export-actions">
          <Button icon={<Wand2 size={16} />} onClick={() => updateSelectedClipAudio({ normalize: true, cleanup: true }, "Applied basic clip audio cleanup")}>
            Cleanup
          </Button>
          <Button icon={<RotateCcw size={16} />} onClick={resetSelectedClipAudio}>
            Reset
          </Button>
        </div>
      </Panel>

      <Panel title="Project Mix">
        <div className="control-stack">
          <Slider label="Master" value={projectSettings.masterGainDb ?? 0} min={-24} max={12} step={1} onChange={(event) => {
            const value = Number(event.target.value);
            updateProjectAudio({ masterGainDb: value }, `Project master gain ${value} dB`);
          }} />
          <Toggle label="Export audio" checked={projectSettings.audioEnabled} onChange={(event) => updateProjectAudio({ audioEnabled: event.target.checked }, event.target.checked ? "Project audio enabled" : "Project audio disabled")} />
          <Toggle label="Normalize mix" checked={projectSettings.normalizeAudio} onChange={(event) => updateProjectAudio({ normalizeAudio: event.target.checked }, event.target.checked ? "Project mix normalization on" : "Project mix normalization off")} />
          <Toggle label="Cleanup mix" checked={projectSettings.cleanupAudio} onChange={(event) => updateProjectAudio({ cleanupAudio: event.target.checked }, event.target.checked ? "Project mix cleanup on" : "Project mix cleanup off")} />
        </div>
      </Panel>

      <Panel title="Actions">
        <div className="audio-action-grid">
          <Button icon={<Headphones size={16} />} onClick={() => updateSelectedClipAudio({ normalize: true }, "Clip normalization on")}>
            Normalize
          </Button>
          <Button icon={<Mic2 size={16} />} onClick={() => updateSelectedClipAudio({ cleanup: true }, "Clip cleanup on")}>
            Cleanup
          </Button>
          <Button icon={<RotateCcw size={16} />} onClick={resetSelectedClipAudio}>
            Reset Clip
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function FallbackWaveform() {
  return (
    <>
      {Array.from({ length: 48 }).map((_, index) => (
        <span key={index} style={{ height: `${18 + ((index * 17) % 48)}px` }} />
      ))}
    </>
  );
}

function collectAudioClips(timeline: Timeline, mediaAssets: MediaAsset[]): AudioClipRow[] {
  return timeline.tracks.flatMap((track) =>
    track.clips
      .map((clip) => ({
        clip,
        trackName: track.name,
        asset: mediaAssets.find((asset) => asset.id === clip.mediaId)
      }))
      .filter((row) => row.asset?.kind === "audio" || row.asset?.metadata?.hasAudio)
  );
}

function normalizeAudioAdjustment(value?: Partial<AudioAdjustment>): AudioAdjustment {
  return {
    ...defaultAudioAdjustment,
    ...value
  };
}

function formatClipRange(clip: TimelineClip) {
  return `${formatSeconds(clip.startUs)} to ${formatSeconds(clip.startUs + getClipDisplayDurationUs(clip))}`;
}

function formatSeconds(valueUs: number) {
  return `${(valueUs / 1_000_000).toFixed(2)}s`;
}

function formatSecondsInput(valueUs: number) {
  return Number((valueUs / 1_000_000).toFixed(1));
}

function secondsToUs(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1_000_000) : 0;
}

function normalizeClipSpeedPercent(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(400, Math.max(25, Math.round(numeric))) : 100;
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
  return Math.min(Math.max(clip.inUs, sourceOffsetUs + clip.inUs), Math.max(clip.inUs, clip.outUs - 1));
}

function effectivePlaybackRate(clip: TimelineClip, previewSpeedPercent: number) {
  return Math.min(8, Math.max(0.1, getClipSpeedFactor(clip) * (Math.min(200, Math.max(25, previewSpeedPercent)) / 100)));
}

function dbToLinear(gainDb: number) {
  return Math.pow(10, gainDb / 20);
}
