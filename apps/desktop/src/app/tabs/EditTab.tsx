import { useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { Eye, EyeOff, Lock, Magnet, Pause, Play, Scissors, Trash2, Unlock, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import type { TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { executeCommand } from "../../features/commands/commandClient";
import { starterTimeline } from "../../features/timeline/mockTimeline";
import { previewQualities, type PreviewQuality } from "../../features/playback/preview";

const timelineHeaderWidth = 128;
const minTimelineZoom = 32;
const maxTimelineZoom = 180;
const timelineZoomStep = 8;

interface EditTabProps {
  previewUrl?: string;
  setStatusMessage: (message: string) => void;
}

export function EditTab({ previewUrl, setStatusMessage }: EditTabProps) {
  const [selectedClipId, setSelectedClipId] = useState("clip_intro");
  const [snapping, setSnapping] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("Proxy");
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [playheadUs, setPlayheadUs] = useState(1_500_000);
  const selectedClip = starterTimeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);

  async function splitAtPlayhead() {
    const result = await executeCommand({ type: "split_clip", playheadUs });
    setStatusMessage(result.ok ? "Split command accepted" : result.error ?? "Split failed");
  }

  async function rippleDelete() {
    if (!selectedClip) {
      return;
    }

    const result = await executeCommand({ type: "ripple_delete_clip", clipId: selectedClip.id, trackMode: "selected_track" });
    setStatusMessage(result.ok ? "Ripple delete command accepted" : result.error ?? "Ripple delete failed");
  }

  function zoomTimeline(direction: -1 | 1) {
    setTimelineZoom((value) => clamp(value + direction * timelineZoomStep, minTimelineZoom, maxTimelineZoom));
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
              <IconButton label="Zoom out" icon={<ZoomOut size={17} />} onClick={() => zoomTimeline(-1)} />
              <IconButton label="Zoom in" icon={<ZoomIn size={17} />} onClick={() => zoomTimeline(1)} />
              <IconButton label={snapping ? "Snapping on" : "Snapping off"} icon={<Magnet size={17} />} className={snapping ? "icon-active" : ""} onClick={() => setSnapping((value) => !value)} />
            </div>
          }
        >
          <TimelineSurface
            selectedClipId={selectedClipId}
            onSelectClip={setSelectedClipId}
            playheadUs={playheadUs}
            onPlayheadChange={setPlayheadUs}
            zoomPxPerSecond={timelineZoom}
            onZoom={zoomTimeline}
          />
        </Panel>
      </section>

      <Panel title="Clip Inspector" className="clip-inspector">
        {selectedClip ? <ClipInspector clip={selectedClip} /> : <div className="empty-state">Select a clip.</div>}
      </Panel>
    </div>
  );
}

function TimelineSurface({
  selectedClipId,
  onSelectClip,
  playheadUs,
  onPlayheadChange,
  zoomPxPerSecond,
  onZoom
}: {
  selectedClipId: string;
  onSelectClip: (clipId: string) => void;
  playheadUs: number;
  onPlayheadChange: (playheadUs: number) => void;
  zoomPxPerSecond: number;
  onZoom: (direction: -1 | 1) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const durationSeconds = Math.max(36, Math.ceil(starterTimeline.durationUs / 1_000_000));
  const timelineWidth = Math.max(1200, durationSeconds * zoomPxPerSecond);
  const playheadLeft = timelineHeaderWidth + (playheadUs / 1_000_000) * zoomPxPerSecond;
  const marks = createTimeMarks(durationSeconds);

  function clientXToPlayheadUs(clientX: number) {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return playheadUs;
    }

    const rect = scrollElement.getBoundingClientRect();
    const x = clientX - rect.left + scrollElement.scrollLeft - timelineHeaderWidth;
    const seconds = clamp(x / zoomPxPerSecond, 0, durationSeconds);
    return Math.round(seconds * 1_000_000);
  }

  function updatePlayheadFromPointer(clientX: number) {
    onPlayheadChange(clientXToPlayheadUs(clientX));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest(".timeline-clip, .track-header, .icon-button")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingPlayhead(true);
    updatePlayheadFromPointer(event.clientX);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingPlayhead) {
      return;
    }

    updatePlayheadFromPointer(event.clientX);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingPlayhead) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingPlayhead(false);
    updatePlayheadFromPointer(event.clientX);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.shiftKey) {
      return;
    }

    event.preventDefault();
    onZoom(event.deltaY > 0 ? -1 : 1);
  }

  return (
    <div
      ref={scrollRef}
      className="timeline-scroll"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDraggingPlayhead(false)}
      onWheel={handleWheel}
    >
      <div className="timeline-surface" style={{ width: `${timelineHeaderWidth + timelineWidth}px` }}>
        <div className="time-ruler" style={{ gridTemplateColumns: `${timelineHeaderWidth}px ${timelineWidth}px` }}>
          <div className="time-ruler-spacer" />
          <div className="time-ruler-content" style={{ width: `${timelineWidth}px` }}>
            {marks.map((mark) => (
              <span key={mark.seconds} style={{ left: `${mark.seconds * zoomPxPerSecond}px` }}>
                {mark.label}
              </span>
            ))}
          </div>
        </div>
        <div
          className={draggingPlayhead ? "playhead dragging" : "playhead"}
          role="slider"
          aria-label="Timeline playhead"
          aria-valuemin={0}
          aria-valuemax={durationSeconds}
          aria-valuenow={Math.round(playheadUs / 1_000_000)}
          style={{ left: `${playheadLeft}px` }}
        >
          <span className="playhead-handle" />
        </div>
        {starterTimeline.tracks.map((track) => (
          <div className="track-row" key={track.id} style={{ gridTemplateColumns: `${timelineHeaderWidth}px ${timelineWidth}px` }}>
            <div className="track-header">
              <span>{track.name}</span>
              <div>
                <IconButton label={track.locked ? "Unlock track" : "Lock track"} icon={track.locked ? <Lock size={14} /> : <Unlock size={14} />} />
                <IconButton label={track.kind === "audio" ? "Mute track" : "Toggle visibility"} icon={track.kind === "audio" ? <Volume2 size={14} /> : track.visible ? <Eye size={14} /> : <EyeOff size={14} />} />
              </div>
            </div>
            <div className="track-lane" style={{ width: `${timelineWidth}px` }}>
              {track.clips.map((clip) => {
                const start = (clip.startUs / 1_000_000) * zoomPxPerSecond;
                const width = Math.max(((clip.outUs - clip.inUs) / 1_000_000) * zoomPxPerSecond, 8);
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={clip.id === selectedClipId ? `timeline-clip ${track.kind} selected` : `timeline-clip ${track.kind}`}
                    data-tight={width < 56 ? "true" : undefined}
                    style={{ left: `${start}px`, width: `${width}px` }}
                    title={clip.mediaId}
                    onPointerDown={(event) => event.stopPropagation()}
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

function createTimeMarks(durationSeconds: number) {
  const marks: Array<{ seconds: number; label: string }> = [];
  for (let seconds = 0; seconds <= durationSeconds; seconds += 5) {
    marks.push({
      seconds,
      label: formatTimelineTime(seconds)
    });
  }
  return marks;
}

function formatTimelineTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
