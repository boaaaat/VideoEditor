import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  Eye,
  EyeOff,
  Film,
  Import,
  Lock,
  Magnet,
  Maximize2,
  Music,
  Pause,
  Play,
  Scissors,
  StepBack,
  StepForward,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import type { TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { executeCommand } from "../../features/commands/commandClient";
import { isTypingTarget } from "../../features/commands/shortcuts";
import { importMediaPaths, type ImportMediaResult } from "../../features/media/importMedia";
import { isSupportedMediaPath, type MediaAsset } from "../../features/media/mediaTypes";
import { starterTimeline } from "../../features/timeline/mockTimeline";
import { previewQualities, type PreviewQuality } from "../../features/playback/preview";

const timelineHeaderWidth = 128;
const minTimelineZoom = 32;
const maxTimelineZoom = 180;
const timelineZoomStep = 8;

interface EditTabProps {
  previewUrl?: string;
  mediaAssets: MediaAsset[];
  onImportMedia: () => Promise<void>;
  onImportMediaResult: (result: ImportMediaResult | null) => void;
  setStatusMessage: (message: string) => void;
}

export function EditTab({ previewUrl, mediaAssets, onImportMedia, onImportMediaResult, setStatusMessage }: EditTabProps) {
  const [selectedClipId, setSelectedClipId] = useState("");
  const [timeline, setTimeline] = useState(starterTimeline);
  const [mediaDragOver, setMediaDragOver] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("Proxy");
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [playheadUs, setPlayheadUs] = useState(0);
  const selectedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);

  async function splitAtPlayhead() {
    const result = await executeCommand({ type: "split_clip", playheadUs });
    if (selectedClip && playheadUs > selectedClip.startUs && playheadUs < selectedClip.startUs + (selectedClip.outUs - selectedClip.inUs)) {
      const firstOutUs = selectedClip.inUs + (playheadUs - selectedClip.startUs);
      const secondDurationUs = selectedClip.outUs - firstOutUs;
      const secondClip = {
        ...selectedClip,
        id: `clip_${Date.now()}`,
        startUs: playheadUs,
        inUs: firstOutUs,
        outUs: firstOutUs + secondDurationUs
      };

      setTimeline((current) => ({
        ...current,
        tracks: current.tracks.map((track) =>
          track.id === selectedClip.trackId
            ? {
                ...track,
                clips: track.clips.flatMap((clip) => (clip.id === selectedClip.id ? [{ ...clip, outUs: firstOutUs }, secondClip] : [clip]))
              }
            : track
        )
      }));
      setSelectedClipId(secondClip.id);
    }

    setStatusMessage(result.ok ? "Split command accepted" : result.error ?? "Split failed");
  }

  async function addTrack(kind: "video" | "audio") {
    const result = await executeCommand({ type: "add_track", kind });
    setTimeline((current) => {
      const trackCount = current.tracks.filter((track) => track.kind === kind).length + 1;
      const track = {
        id: `${kind[0]}${Date.now()}`,
        name: `${kind === "video" ? "Video" : "Audio"} ${trackCount}`,
        kind,
        index: current.tracks.length,
        locked: false,
        muted: false,
        visible: true,
        clips: []
      };

      return {
        ...current,
        tracks: [...current.tracks, track]
      };
    });
    setStatusMessage(result.ok ? `Add ${kind} track command accepted` : result.error ?? "Add track failed");
  }

  async function deleteSelectedClip() {
    if (!selectedClip) {
      setStatusMessage("No clip selected");
      return;
    }

    const result = await executeCommand({ type: "delete_clip", clipId: selectedClip.id });
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.filter((clip) => clip.id !== selectedClip.id)
      }))
    }));
    setSelectedClipId("");
    setStatusMessage(result.ok ? "Delete command accepted" : result.error ?? "Delete failed");
  }

  async function rippleDelete() {
    if (!selectedClip) {
      setStatusMessage("No clip selected");
      return;
    }

    const result = await executeCommand({ type: "ripple_delete_clip", clipId: selectedClip.id, trackMode: "selected_track" });
    const deletedDuration = selectedClip.outUs - selectedClip.inUs;
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) =>
        track.id === selectedClip.trackId
          ? {
              ...track,
              clips: track.clips
                .filter((clip) => clip.id !== selectedClip.id)
                .map((clip) => (clip.startUs > selectedClip.startUs ? { ...clip, startUs: Math.max(0, clip.startUs - deletedDuration) } : clip))
            }
          : track
      )
    }));
    setSelectedClipId("");
    setStatusMessage(result.ok ? "Ripple delete command accepted" : result.error ?? "Ripple delete failed");
  }

  function zoomTimeline(direction: -1 | 1) {
    setTimelineZoom((value) => clamp(value + direction * timelineZoomStep, minTimelineZoom, maxTimelineZoom));
  }

  function fitTimeline() {
    setTimelineZoom(72);
  }

  async function nudgeSelectedClip(direction: -1 | 1) {
    if (!selectedClip) {
      setStatusMessage("No clip selected");
      return;
    }

    const result = await executeCommand({
      type: "move_clip",
      clipId: selectedClip.id,
      trackId: selectedClip.trackId,
      startUs: Math.max(0, selectedClip.startUs + direction * 100_000),
      snapping
    });
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (clip.id === selectedClip.id ? { ...clip, startUs: Math.max(0, clip.startUs + direction * 100_000) } : clip))
      }))
    }));
    setStatusMessage(result.ok ? "Nudge command accepted" : result.error ?? "Nudge failed");
  }

  async function addMediaToTimeline(asset: MediaAsset, targetTrackId?: string, startUs = playheadUs) {
    const targetTrack = targetTrackId
      ? timeline.tracks.find((track) => track.id === targetTrackId)
      : timeline.tracks.find((track) => track.kind === asset.kind && track.name.endsWith("1")) ?? timeline.tracks.find((track) => track.kind === asset.kind);

    if (!targetTrack) {
      setStatusMessage(`Add an ${asset.kind} track first`);
      return;
    }

    if (targetTrack.kind !== asset.kind) {
      setStatusMessage(`${asset.name} belongs on an ${asset.kind} track`);
      return;
    }

    const durationUs = asset.kind === "audio" ? 12_000_000 : 8_000_000;
    const clipId = `clip_${Date.now()}`;
    const result = await executeCommand({
      type: "add_clip",
      mediaId: asset.id,
      trackId: targetTrack.id,
      startUs,
      inUs: 0,
      outUs: durationUs
    });

    setTimeline((current) => ({
      ...current,
      durationUs: Math.max(current.durationUs, startUs + durationUs + 5_000_000),
      tracks: current.tracks.map((track) =>
        track.id === targetTrack.id
          ? {
              ...track,
              clips: [
                ...track.clips,
                {
                  id: clipId,
                  mediaId: asset.id,
                  trackId: targetTrack.id,
                  startUs,
                  inUs: 0,
                  outUs: durationUs,
                  color: {
                    brightness: 0,
                    contrast: 0,
                    saturation: 1,
                    temperature: 0,
                    tint: 0
                  }
                }
              ].sort((left, right) => left.startUs - right.startUs)
            }
          : track
      )
    }));
    setSelectedClipId(clipId);
    setStatusMessage(result.ok ? `Added ${asset.name} to timeline` : result.error ?? "Add clip failed");
  }

  async function importDroppedPaths(paths: string[]) {
    const supported = paths.filter(isSupportedMediaPath);
    if (supported.length === 0) {
      setStatusMessage("No supported media dropped");
      return;
    }

    onImportMediaResult(await importMediaPaths(supported));
  }

  async function handleMediaDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setMediaDragOver(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path ?? file.name)
      .filter(Boolean);

    await importDroppedPaths(paths);
  }

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow()
        .onDragDropEvent((event) => {
          const payload = event.payload as { type: string; paths?: string[] };
          if (payload.type === "drop" && payload.paths) {
            void importDroppedPaths(payload.paths);
          }
        })
        .then((cleanup) => {
          unlisten = cleanup;
        });
    });

    return () => {
      unlisten?.();
    };
  }, [onImportMediaResult]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        setPlaying((value) => !value);
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void splitAtPlayhead();
      }

      if (!event.ctrlKey && !event.altKey && event.key === "Delete") {
        event.preventDefault();
        if (event.shiftKey) {
          void rippleDelete();
        } else {
          void deleteSelectedClip();
        }
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setSnapping((value) => !value);
      }

      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void nudgeSelectedClip(-1);
      }

      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        void nudgeSelectedClip(1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playheadUs, selectedClip, snapping]);

  return (
    <div className="edit-workspace">
      <Panel title="Media Bin" className="media-bin">
        <div
          className={mediaDragOver ? "media-drop-zone drag-over" : "media-drop-zone"}
          onDragOver={(event) => {
            event.preventDefault();
            setMediaDragOver(true);
          }}
          onDragLeave={() => setMediaDragOver(false)}
          onDrop={handleMediaDrop}
        >
          {mediaAssets.length > 0 ? (
            <div className="media-list">
              {mediaAssets.map((asset) => (
                <button
                  type="button"
                  key={asset.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-ai-video-media-id", asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onDoubleClick={() => addMediaToTimeline(asset)}
                >
                  <span className={asset.kind === "video" ? "media-thumb video-thumb" : "media-thumb audio-thumb"} />
                  <span>{asset.name}</span>
                  <small>{asset.kind.toUpperCase()} - {asset.extension}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="media-empty">
              <Import size={24} />
              <Button icon={<Import size={16} />} variant="primary" onClick={onImportMedia}>
                Import Media
              </Button>
            </div>
          )}
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
              <Button icon={<Trash2 size={16} />} onClick={deleteSelectedClip}>
                Delete
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
          <div className="timeline-panel">
            <div className="timeline-toolbar">
              <Button icon={<Film size={16} />} onClick={() => addTrack("video")}>
                Video Track
              </Button>
              <Button icon={<Music size={16} />} onClick={() => addTrack("audio")}>
                Audio Track
              </Button>
              <Button icon={<Scissors size={16} />} onClick={splitAtPlayhead}>
                Split
              </Button>
              <Button icon={<Trash2 size={16} />} onClick={deleteSelectedClip}>
                Delete
              </Button>
              <Button icon={<Trash2 size={16} />} variant="danger" onClick={rippleDelete}>
                Ripple
              </Button>
              <IconButton label="Nudge left" icon={<StepBack size={17} />} onClick={() => nudgeSelectedClip(-1)} />
              <IconButton label="Nudge right" icon={<StepForward size={17} />} onClick={() => nudgeSelectedClip(1)} />
              <IconButton label="Fit timeline" icon={<Maximize2 size={17} />} onClick={fitTimeline} />
              <Toggle label="Snapping" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />
              <span className="timeline-timecode">{formatTimelineTime(Math.floor(playheadUs / 1_000_000))}</span>
            </div>
            <TimelineSurface
              timeline={timeline}
              mediaAssets={mediaAssets}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              playheadUs={playheadUs}
              onPlayheadChange={setPlayheadUs}
              zoomPxPerSecond={timelineZoom}
              onZoom={zoomTimeline}
              onAddMediaToTimeline={addMediaToTimeline}
              setStatusMessage={setStatusMessage}
            />
          </div>
        </Panel>
      </section>

      <Panel title="Clip Inspector" className="clip-inspector">
        {selectedClip ? <ClipInspector clip={selectedClip} /> : <div className="empty-state">Select a clip.</div>}
      </Panel>
    </div>
  );
}

function TimelineSurface({
  timeline,
  mediaAssets,
  selectedClipId,
  onSelectClip,
  playheadUs,
  onPlayheadChange,
  zoomPxPerSecond,
  onZoom,
  onAddMediaToTimeline,
  setStatusMessage
}: {
  timeline: typeof starterTimeline;
  mediaAssets: MediaAsset[];
  selectedClipId: string;
  onSelectClip: (clipId: string) => void;
  playheadUs: number;
  onPlayheadChange: (playheadUs: number) => void;
  zoomPxPerSecond: number;
  onZoom: (direction: -1 | 1) => void;
  onAddMediaToTimeline: (asset: MediaAsset, targetTrackId?: string, startUs?: number) => Promise<void>;
  setStatusMessage: (message: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const durationSeconds = Math.max(60, Math.ceil(timeline.durationUs / 1_000_000));
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
        {timeline.tracks.map((track) => (
          <div className="track-row" key={track.id} style={{ gridTemplateColumns: `${timelineHeaderWidth}px ${timelineWidth}px` }}>
            <div className="track-header">
              <span>{track.name}</span>
              <div>
                <IconButton label={track.locked ? "Unlock track" : "Lock track"} icon={track.locked ? <Lock size={14} /> : <Unlock size={14} />} />
                <IconButton label={track.kind === "audio" ? "Mute track" : "Toggle visibility"} icon={track.kind === "audio" ? <Volume2 size={14} /> : track.visible ? <Eye size={14} /> : <EyeOff size={14} />} />
              </div>
            </div>
            <div
              className="track-lane"
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const mediaId = event.dataTransfer.getData("application/x-ai-video-media-id");
                const asset = mediaAssets.find((item) => item.id === mediaId);
                if (!asset) {
                  setStatusMessage("Drop imported media from the media bin");
                  return;
                }

                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const startUs = Math.round(clamp(x / zoomPxPerSecond, 0, durationSeconds) * 1_000_000);
                void onAddMediaToTimeline(asset, track.id, startUs);
              }}
            >
              {track.clips.map((clip) => {
                const start = (clip.startUs / 1_000_000) * zoomPxPerSecond;
                const width = Math.max(((clip.outUs - clip.inUs) / 1_000_000) * zoomPxPerSecond, 8);
                const mediaName = mediaAssets.find((asset) => asset.id === clip.mediaId)?.name ?? clip.mediaId;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={clip.id === selectedClipId ? `timeline-clip ${track.kind} selected` : `timeline-clip ${track.kind}`}
                    data-tight={width < 56 ? "true" : undefined}
                    style={{ left: `${start}px`, width: `${width}px` }}
                    title={mediaName}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onSelectClip(clip.id)}
                  >
                    <span>{mediaName}</span>
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
