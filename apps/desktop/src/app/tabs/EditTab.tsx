import { useState } from "react";
import { Eye, EyeOff, Lock, Magnet, Pause, Play, Scissors, Trash2, Unlock, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import type { TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { executeCommand } from "../../features/commands/commandClient";
import { starterTimeline } from "../../features/timeline/mockTimeline";
import { previewQualities, type PreviewQuality } from "../../features/playback/preview";

interface EditTabProps {
  previewUrl?: string;
  setStatusMessage: (message: string) => void;
}

export function EditTab({ previewUrl, setStatusMessage }: EditTabProps) {
  const [selectedClipId, setSelectedClipId] = useState("clip_intro");
  const [snapping, setSnapping] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("Proxy");
  const selectedClip = starterTimeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);

  async function splitAtPlayhead() {
    const result = await executeCommand({ type: "split_clip", playheadUs: 6_000_000 });
    setStatusMessage(result.ok ? "Split command accepted" : result.error ?? "Split failed");
  }

  async function rippleDelete() {
    if (!selectedClip) {
      return;
    }

    const result = await executeCommand({ type: "ripple_delete_clip", clipId: selectedClip.id, trackMode: "selected_track" });
    setStatusMessage(result.ok ? "Ripple delete command accepted" : result.error ?? "Ripple delete failed");
  }

  return (
    <div className="edit-workspace">
      <Panel title="Media Bin" className="media-bin">
        <div className="media-list">
          <button type="button">
            <span className="media-thumb video-thumb" />
            <span>interview_take_01.mp4</span>
            <small>4K 30fps</small>
          </button>
          <button type="button">
            <span className="media-thumb video-thumb alt" />
            <span>broll_city.mov</span>
            <small>1440p 60fps</small>
          </button>
          <button type="button">
            <span className="media-thumb audio-thumb" />
            <span>voiceover.mp3</span>
            <small>Audio</small>
          </button>
        </div>
      </Panel>

      <section className="preview-and-timeline">
        <Panel
          title="Preview"
          actions={
            <select value={previewQuality} onChange={(event) => setPreviewQuality(event.target.value as PreviewQuality)}>
              {previewQualities.map((quality) => (
                <option key={quality}>{quality}</option>
              ))}
            </select>
          }
        >
          <div className="preview-player">
            <div className="preview-frame">
              <span>{previewUrl ? "Engine preview stream ready" : "Preview waiting for engine"}</span>
              <small>{previewUrl ?? "http://127.0.0.1:47110/preview"}</small>
            </div>
            <div className="transport">
              <IconButton label={playing ? "Pause" : "Play"} icon={playing ? <Pause size={18} /> : <Play size={18} />} onClick={() => setPlaying((value) => !value)} />
              <Button icon={<Scissors size={16} />} onClick={splitAtPlayhead}>
                Split
              </Button>
              <Button icon={<Trash2 size={16} />} variant="danger" onClick={rippleDelete}>
                Ripple Delete
              </Button>
              <Toggle label="Snapping" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />
            </div>
          </div>
        </Panel>

        <Panel
          title="Timeline"
          actions={
            <div className="timeline-actions">
              <IconButton label="Zoom out" icon={<ZoomOut size={17} />} />
              <IconButton label="Zoom in" icon={<ZoomIn size={17} />} />
              <IconButton label={snapping ? "Snapping on" : "Snapping off"} icon={<Magnet size={17} />} className={snapping ? "icon-active" : ""} onClick={() => setSnapping((value) => !value)} />
            </div>
          }
        >
          <TimelineSurface selectedClipId={selectedClipId} onSelectClip={setSelectedClipId} />
        </Panel>
      </section>

      <Panel title="Clip Inspector" className="clip-inspector">
        {selectedClip ? <ClipInspector clip={selectedClip} /> : <div className="empty-state">Select a clip.</div>}
      </Panel>
    </div>
  );
}

function TimelineSurface({ selectedClipId, onSelectClip }: { selectedClipId: string; onSelectClip: (clipId: string) => void }) {
  return (
    <div className="timeline-surface">
      <div className="time-ruler">
        {["00:00", "00:05", "00:10", "00:15", "00:20", "00:25", "00:30"].map((mark) => (
          <span key={mark}>{mark}</span>
        ))}
      </div>
      <div className="playhead" />
      {starterTimeline.tracks.map((track) => (
        <div className="track-row" key={track.id}>
          <div className="track-header">
            <span>{track.name}</span>
            <div>
              <IconButton label={track.locked ? "Unlock track" : "Lock track"} icon={track.locked ? <Lock size={14} /> : <Unlock size={14} />} />
              <IconButton label={track.kind === "audio" ? "Mute track" : "Toggle visibility"} icon={track.kind === "audio" ? <Volume2 size={14} /> : track.visible ? <Eye size={14} /> : <EyeOff size={14} />} />
            </div>
          </div>
          <div className="track-lane">
            {track.clips.map((clip) => {
              const start = clip.startUs / 400_000;
              const width = (clip.outUs - clip.inUs) / 400_000;
              return (
                <button
                  type="button"
                  key={clip.id}
                  className={clip.id === selectedClipId ? `timeline-clip ${track.kind} selected` : `timeline-clip ${track.kind}`}
                  style={{ left: `${start}px`, width: `${width}px` }}
                  onClick={() => onSelectClip(clip.id)}
                >
                  <span>{clip.mediaId}</span>
                  {track.kind === "audio" ? <VolumeX size={13} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ClipInspector({ clip }: { clip: TimelineClip }) {
  const durationSeconds = ((clip.outUs - clip.inUs) / 1_000_000).toFixed(2);

  return (
    <div className="inspector-stack">
      <label>
        Clip ID
        <input value={clip.id} readOnly />
      </label>
      <label>
        Start
        <input value={`${(clip.startUs / 1_000_000).toFixed(2)}s`} readOnly />
      </label>
      <label>
        Duration
        <input value={`${durationSeconds}s`} readOnly />
      </label>
      <label>
        Scale
        <input type="number" value={100} readOnly />
      </label>
      <label>
        Opacity
        <input type="number" value={100} readOnly />
      </label>
    </div>
  );
}
