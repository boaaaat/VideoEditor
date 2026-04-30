import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { defaultClipEffects, defaultClipTransform, type ClipEffect, type ClipTransform, type ProjectSettings, type Timeline, type TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";
import { Toggle } from "../../components/Toggle";
import type { LogStatus } from "../../features/logging/appLog";
import type { MediaAsset } from "../../features/media/mediaTypes";
import { ColorEffectsPlayback } from "./ColorEffectsPlayback";

interface EffectsTabProps {
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
  setStatusMessage: LogStatus;
}

export function EffectsTab({
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
  setStatusMessage
}: EffectsTabProps) {
  const videoClips = collectVideoClips(timeline);
  const [selectedClipId, setSelectedClipId] = useState("");
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId) ?? videoClips[0];
  const transform = normalizeTransform(selectedClip?.transform);
  const effects = normalizeEffects(selectedClip?.effects);

  useEffect(() => {
    if (!selectedClipId && videoClips[0]) {
      setSelectedClipId(videoClips[0].id);
    } else if (selectedClipId && !videoClips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(videoClips[0]?.id ?? "");
    }
  }, [selectedClipId, videoClips]);

  function updateSelectedClipTransform(next: Partial<ClipTransform>, label: string) {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }

    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      transform: {
        ...normalizeTransform(clip.transform),
        ...next
      }
    })));
    setStatusMessage(label, { details: { clipId: selectedClip.id, transform: next } });
  }

  function updateSelectedClipEffects(nextEffects: ClipEffect[], label: string) {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }

    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      effects: nextEffects
    })));
    setStatusMessage(label, { details: { clipId: selectedClip.id, effects: nextEffects } });
  }

  function updateEffect(effectId: string, next: Partial<ClipEffect>, label: string) {
    updateSelectedClipEffects(
      effects.map((effect) => (effect.id === effectId ? { ...effect, ...next } : effect)),
      label
    );
  }

  function resetEffects() {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }
    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      transform: defaultClipTransform,
      effects: defaultClipEffects
    })));
    setStatusMessage("Reset clip transform and effects", { details: { clipId: selectedClip.id } });
  }

  return (
    <div className="color-effects-workspace">
      <Panel title="Playback" className="color-effects-playback">
        <ColorEffectsPlayback
          timeline={timeline}
          mediaAssets={mediaAssets}
          projectSettings={projectSettings}
          selectedClipId={selectedClip?.id ?? ""}
          onSelectedClipIdChange={setSelectedClipId}
          playheadUs={playheadUs}
          setPlayheadUs={setPlayheadUs}
          playing={playing}
          setPlaying={setPlaying}
          previewVolumePercent={previewVolumePercent}
          previewSpeedPercent={previewSpeedPercent}
        />
      </Panel>
      <div className="color-effects-controls-dock">
      <Panel title="Clip">
        <div className="control-stack">
          <label>
            Video clip
            <select
              value={selectedClip?.id ?? ""}
              onChange={(event) => {
                setSelectedClipId(event.target.value);
                const clip = videoClips.find((item) => item.id === event.target.value);
                if (clip) {
                  setPlayheadUs(clip.startUs);
                }
              }}
              disabled={videoClips.length === 0}
            >
              {videoClips.length === 0 ? <option value="">No video clips</option> : null}
              {videoClips.map((clip) => (
                <option key={clip.id} value={clip.id}>{clip.id} - {formatSeconds(clip.startUs)}</option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <Panel title="Transform">
        <div className="control-stack">
          <Toggle label="Transform enabled" checked={transform.enabled} onChange={(event) => updateSelectedClipTransform({ enabled: event.target.checked }, event.target.checked ? "Transform enabled" : "Transform disabled")} />
          <Slider label="Scale" value={Math.round(transform.scale * 100)} min={10} max={400} step={1} onChange={(event) => updateSelectedClipTransform({ scale: Number(event.target.value) / 100 }, "Clip scale changed")} />
          <Slider label="Position X" value={Math.round(transform.positionX)} min={-2000} max={2000} step={1} onChange={(event) => updateSelectedClipTransform({ positionX: Number(event.target.value) }, "Clip X position changed")} />
          <Slider label="Position Y" value={Math.round(transform.positionY)} min={-2000} max={2000} step={1} onChange={(event) => updateSelectedClipTransform({ positionY: Number(event.target.value) }, "Clip Y position changed")} />
          <Slider label="Rotation" value={Number(transform.rotation.toFixed(1))} min={-180} max={180} step={0.1} onChange={(event) => updateSelectedClipTransform({ rotation: Number(event.target.value) }, "Clip rotation changed")} />
          <Slider label="Opacity" value={Math.round(transform.opacity * 100)} min={0} max={100} step={1} onChange={(event) => updateSelectedClipTransform({ opacity: Number(event.target.value) / 100 }, "Clip opacity changed")} />
        </div>
      </Panel>

      <Panel title="Effects Stack">
        <div className="effects-stack">
          {effects.map((effect) => (
            <div className="effect-row" key={effect.id}>
              <Toggle label={effect.label} checked={effect.enabled} onChange={(event) => updateEffect(effect.id, { enabled: event.target.checked }, `${effect.label} ${event.target.checked ? "enabled" : "disabled"}`)} />
              <Slider label="Amount" value={Math.round(effect.amount)} min={0} max={100} step={1} onChange={(event) => updateEffect(effect.id, { amount: Number(event.target.value), enabled: Number(event.target.value) > 0 }, `${effect.label} amount changed`)} />
            </div>
          ))}
        </div>
        <div className="export-actions">
          <Button icon={<SlidersHorizontal size={16} />} onClick={() => updateSelectedClipEffects(effects.map((effect) => ({ ...effect, enabled: effect.amount > 0 })), "Enabled active effects")}>
            Enable Active
          </Button>
          <Button icon={<RotateCcw size={16} />} onClick={resetEffects}>
            Reset Effects
          </Button>
        </div>
      </Panel>
      </div>
    </div>
  );
}

function collectVideoClips(timeline: Timeline) {
  return timeline.tracks.flatMap((track) => track.kind === "video" ? track.clips : []);
}

function normalizeTransform(value?: Partial<ClipTransform>): ClipTransform {
  return {
    ...defaultClipTransform,
    ...value
  };
}

function normalizeEffects(value?: ClipEffect[]): ClipEffect[] {
  const existingById = new Map((value ?? []).map((effect) => [effect.id, effect]));
  return defaultClipEffects.map((effect) => ({
    ...effect,
    ...existingById.get(effect.id)
  }));
}

function updateClip(timeline: Timeline, clipId: string, updater: (clip: TimelineClip) => TimelineClip): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => (clip.id === clipId ? updater(clip) : clip))
    }))
  };
}

function formatSeconds(valueUs: number) {
  return `${(valueUs / 1_000_000).toFixed(2)}s`;
}
