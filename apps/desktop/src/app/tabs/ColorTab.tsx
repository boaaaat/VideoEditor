import { RotateCcw } from "lucide-react";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { defaultColorAdjustment, type ColorAdjustment, type ClipLut, type ProjectSettings, type Timeline, type TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";
import type { LogStatus } from "../../features/logging/appLog";
import type { MediaAsset } from "../../features/media/mediaTypes";
import { ColorEffectsPlayback } from "./ColorEffectsPlayback";

type LutPresetId = "" | "warm" | "cool" | "filmic" | "mono";

const lutPresetLabels: Record<LutPresetId, string> = {
  "": "None",
  warm: "Warm Lift",
  cool: "Cool Shadows",
  filmic: "Filmic Contrast",
  mono: "Soft Mono"
};

interface ColorTabProps {
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

export function ColorTab({
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
}: ColorTabProps) {
  const videoClips = collectVideoClips(timeline);
  const [selectedClipId, setSelectedClipId] = useState("");
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId) ?? videoClips[0];
  const color = normalizeColor(selectedClip?.color);
  const lut = selectedClip?.lut;

  useEffect(() => {
    if (!selectedClipId && videoClips[0]) {
      setSelectedClipId(videoClips[0].id);
    } else if (selectedClipId && !videoClips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(videoClips[0]?.id ?? "");
    }
  }, [selectedClipId, videoClips]);

  function updateSelectedClipColor(next: Partial<ColorAdjustment>, label: string) {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }

    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      color: {
        ...normalizeColor(clip.color),
        ...next
      }
    })));
    setStatusMessage(label, { details: { clipId: selectedClip.id, adjustment: next } });
  }

  function updateSelectedClipLut(next: ClipLut | undefined, label: string) {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }

    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      lut: next
    })));
    setStatusMessage(label, { details: { clipId: selectedClip.id, lut: next } });
  }

  function resetColor() {
    if (!selectedClip) {
      setStatusMessage("Select a video clip first", { level: "warning" });
      return;
    }
    setTimeline((current) => updateClip(current, selectedClip.id, (clip) => ({
      ...clip,
      color: defaultColorAdjustment,
      lut: undefined
    })));
    setStatusMessage("Reset clip color", { details: { clipId: selectedClip.id } });
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

      <Panel title="Basic Adjustment">
        <div className="control-stack">
          <Slider label="Brightness" value={Math.round(color.brightness)} min={-100} max={100} step={1} onChange={(event) => updateSelectedClipColor({ brightness: Number(event.target.value) }, "Clip brightness changed")} />
          <Slider label="Contrast" value={Math.round(color.contrast)} min={-100} max={100} step={1} onChange={(event) => updateSelectedClipColor({ contrast: Number(event.target.value) }, "Clip contrast changed")} />
          <Slider label="Saturation" value={Math.round(color.saturation * 100)} min={0} max={200} step={1} onChange={(event) => updateSelectedClipColor({ saturation: Number(event.target.value) / 100 }, "Clip saturation changed")} />
          <Slider label="Temperature" value={Math.round(color.temperature)} min={-100} max={100} step={1} onChange={(event) => updateSelectedClipColor({ temperature: Number(event.target.value) }, "Clip temperature changed")} />
          <Slider label="Tint" value={Math.round(color.tint)} min={-100} max={100} step={1} onChange={(event) => updateSelectedClipColor({ tint: Number(event.target.value) }, "Clip tint changed")} />
        </div>
      </Panel>

      <Panel title="LUT">
        <div className="control-stack">
          <label>
            Look
            <select
              value={(lut?.lutId as LutPresetId | undefined) ?? ""}
              onChange={(event) => {
                const lutId = event.target.value as LutPresetId;
                updateSelectedClipLut(lutId ? { lutId, strength: lut?.strength ?? 1 } : undefined, lutId ? `Applied ${lutPresetLabels[lutId]} LUT` : "Cleared LUT");
              }}
            >
              {(Object.keys(lutPresetLabels) as LutPresetId[]).map((value) => (
                <option key={value || "none"} value={value}>{lutPresetLabels[value]}</option>
              ))}
            </select>
          </label>
          <Slider label="Strength" value={Math.round((lut?.strength ?? 1) * 100)} min={0} max={100} step={1} onChange={(event) => {
            const strength = Number(event.target.value) / 100;
            updateSelectedClipLut(lut?.lutId ? { lutId: lut.lutId, strength } : undefined, "LUT strength changed");
          }} />
          <Button icon={<RotateCcw size={16} />} onClick={resetColor}>Reset Color</Button>
        </div>
      </Panel>
      </div>
    </div>
  );
}

function collectVideoClips(timeline: Timeline) {
  return timeline.tracks.flatMap((track) => track.kind === "video" ? track.clips : []);
}

function normalizeColor(value?: Partial<ColorAdjustment>): ColorAdjustment {
  return {
    ...defaultColorAdjustment,
    ...value
  };
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
