import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
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
import { getMediaDurationUs, getMediaSourceUrl, getMediaThumbnailDataUrl, isSupportedMediaPath, type MediaAsset } from "../../features/media/mediaTypes";
import { starterTimeline } from "../../features/timeline/mockTimeline";
import { previewQualities, type PreviewQuality } from "../../features/playback/preview";

const timelineHeaderWidth = 128;
const minTimelineZoom = 32;
const maxTimelineZoom = 180;
const timelineZoomStep = 8;
const snapIntervalUs = 500_000;
const defaultVideoDurationUs = 8_000_000;
const defaultAudioDurationUs = 12_000_000;

interface EditTabProps {
  previewUrl?: string;
  mediaAssets: MediaAsset[];
  onImportMedia: () => Promise<void>;
  onImportMediaResult: (result: ImportMediaResult | null) => void;
  setStatusMessage: (message: string) => void;
}

interface ClipInteraction {
  mode: "move" | "trim-start" | "trim-end";
  clipId: string;
  startClientX: number;
  originalStartUs: number;
  originalInUs: number;
  originalOutUs: number;
  originalTrackId: string;
}

interface PreviewClipState {
  clipId: string;
  startUs: number;
  inUs: number;
  outUs: number;
  trackId: string;
}

interface MediaPointerDragState {
  asset: MediaAsset;
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  active: boolean;
}

export function EditTab({ previewUrl, mediaAssets, onImportMedia, onImportMediaResult, setStatusMessage }: EditTabProps) {
  const playbackFrameRef = useRef<number | null>(null);
  const lastPlaybackTimeRef = useRef<number | null>(null);
  const internalMediaDragRef = useRef(false);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [timeline, setTimeline] = useState(starterTimeline);
  const [mediaDragOver, setMediaDragOver] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("Proxy");
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [playheadUs, setPlayheadUs] = useState(0);
  const [draggingMediaId, setDraggingMediaId] = useState<string | null>(null);
  const [mediaDropTrackId, setMediaDropTrackId] = useState<string | null>(null);
  const [mediaDragState, setMediaDragState] = useState<MediaPointerDragState | null>(null);
  const selectedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const activeVideoClip = findActiveClip(timeline, playheadUs, "video");
  const activeAudioClip = findActiveClip(timeline, playheadUs, "audio");
  const activeVideoAsset = activeVideoClip ? mediaAssets.find((asset) => asset.id === activeVideoClip.mediaId) : undefined;
  const activeAudioAsset = activeAudioClip ? mediaAssets.find((asset) => asset.id === activeAudioClip.mediaId) : undefined;

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

  function toggleTrack(trackId: string, field: "locked" | "muted" | "visible") {
    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (track.id === trackId ? { ...track, [field]: !track[field] } : track))
    }));
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
    const durationSeconds = Math.max(1, Math.ceil(timeline.durationUs / 1_000_000));
    const fittedZoom = clamp(Math.floor(1100 / durationSeconds), minTimelineZoom, maxTimelineZoom);
    setTimelineZoom(fittedZoom);
  }

  function stopPlayback() {
    setPlaying(false);
    if (playbackFrameRef.current !== null) {
      cancelAnimationFrame(playbackFrameRef.current);
      playbackFrameRef.current = null;
    }
    lastPlaybackTimeRef.current = null;
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

  async function moveClip(clipId: string, targetTrackId: string, startUs: number) {
    const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    const targetTrack = timeline.tracks.find((track) => track.id === targetTrackId);
    if (!clip || !targetTrack) {
      return;
    }

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`);
      return;
    }

    const sourceAsset = mediaAssets.find((asset) => asset.id === clip.mediaId);
    if (sourceAsset && sourceAsset.kind !== targetTrack.kind) {
      setStatusMessage(`${sourceAsset.name} belongs on a ${sourceAsset.kind} track`);
      return;
    }

    const nextStartUs = snapping ? snapTime(startUs) : Math.max(0, startUs);
    const result = await executeCommand({
      type: "move_clip",
      clipId,
      trackId: targetTrackId,
      startUs: nextStartUs,
      snapping
    });

    setTimeline((current) => {
      let movedClip = current.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
      if (!movedClip) {
        return current;
      }

      movedClip = { ...movedClip, trackId: targetTrackId, startUs: nextStartUs };
      return {
        ...current,
        durationUs: Math.max(current.durationUs, nextStartUs + (movedClip.outUs - movedClip.inUs) + 5_000_000),
        tracks: current.tracks.map((track) =>
          track.id === targetTrackId
            ? {
                ...track,
                clips: [...track.clips.filter((item) => item.id !== clipId), movedClip].sort((left, right) => left.startUs - right.startUs)
              }
            : {
                ...track,
                clips: track.clips.filter((item) => item.id !== clipId)
              }
        )
      };
    });
    setSelectedClipId(clipId);
    setStatusMessage(result.ok ? "Moved clip" : result.error ?? "Move clip failed");
  }

  async function trimClip(clipId: string, edge: "start" | "end", deltaUs: number) {
    const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    if (!clip) {
      return;
    }

    const track = timeline.tracks.find((item) => item.id === clip.trackId);
    if (track?.locked) {
      setStatusMessage(`${track.name} is locked`);
      return;
    }

    const minDurationUs = 250_000;
    let nextClip = clip;
    if (edge === "start") {
      const nextStartUs = Math.max(0, clip.startUs + deltaUs);
      const nextInUs = Math.max(0, clip.inUs + (nextStartUs - clip.startUs));
      if (clip.outUs - nextInUs < minDurationUs) {
        return;
      }
      nextClip = { ...clip, startUs: snapping ? snapTime(nextStartUs) : nextStartUs, inUs: nextInUs };
    } else {
      const nextOutUs = Math.max(clip.inUs + minDurationUs, clip.outUs + deltaUs);
      nextClip = { ...clip, outUs: nextOutUs };
    }

    const result = await executeCommand({
      type: "trim_clip",
      clipId,
      edge,
      timeUs: edge === "start" ? nextClip.startUs : nextClip.outUs
    });

    setTimeline((current) => ({
      ...current,
      durationUs: Math.max(current.durationUs, nextClip.startUs + (nextClip.outUs - nextClip.inUs) + 5_000_000),
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((item) => (item.id === clipId ? nextClip : item))
      }))
    }));
    setSelectedClipId(clipId);
    setStatusMessage(result.ok ? "Trimmed clip" : result.error ?? "Trim failed");
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

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`);
      return;
    }

    const fallbackDurationUs = asset.kind === "audio" ? defaultAudioDurationUs : defaultVideoDurationUs;
    const durationUs = await getMediaDurationUs(asset, fallbackDurationUs);
    const nextStartUs = snapping ? snapTime(startUs) : startUs;
    const clipId = `clip_${Date.now()}`;
    const result = await executeCommand({
      type: "add_clip",
      mediaId: asset.id,
      trackId: targetTrack.id,
      startUs: nextStartUs,
      inUs: 0,
      outUs: durationUs
    });

    setTimeline((current) => ({
      ...current,
      durationUs: Math.max(current.durationUs, nextStartUs + durationUs + 5_000_000),
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
                  startUs: nextStartUs,
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
    if (internalMediaDragRef.current) {
      return;
    }

    const supported = paths.filter(isSupportedMediaPath);
    if (supported.length === 0) {
      if (paths.length > 0) {
        setStatusMessage("No supported media dropped");
      }
      return;
    }

    onImportMediaResult(await importMediaPaths(supported));
  }

  async function handleMediaDrop(event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    setMediaDragOver(false);
    if (internalMediaDragRef.current) {
      return;
    }

    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (file as File & { path?: string }).path ?? file.name)
      .filter(Boolean);

    await importDroppedPaths(paths);
  }

  function clearMediaPointerDrag() {
    setMediaDragState(null);
    setDraggingMediaId(null);
    setMediaDropTrackId(null);
    window.setTimeout(() => {
      internalMediaDragRef.current = false;
    }, 100);
  }

  function beginMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>, asset: MediaAsset) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    internalMediaDragRef.current = true;
    setMediaDragState({
      asset,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false
    });
    setStatusMessage(`Drag ${asset.name} onto a ${asset.kind} track`);
  }

  function updateMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!mediaDragState || event.pointerId !== mediaDragState.pointerId) {
      return;
    }

    event.preventDefault();
    const moved = Math.hypot(event.clientX - mediaDragState.originX, event.clientY - mediaDragState.originY) > 4;
    const active = mediaDragState.active || moved;
    const drop = active ? getMediaDropAtPoint(event.clientX, event.clientY, timelineZoom, getTimelineDurationSeconds(timeline.durationUs)) : null;

    setMediaDragState({
      ...mediaDragState,
      x: event.clientX,
      y: event.clientY,
      active
    });
    setDraggingMediaId(active ? mediaDragState.asset.id : null);
    setMediaDropTrackId(drop?.trackId ?? null);
  }

  function finishMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!mediaDragState || event.pointerId !== mediaDragState.pointerId) {
      return;
    }

    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const moved = mediaDragState.active || Math.hypot(event.clientX - mediaDragState.originX, event.clientY - mediaDragState.originY) > 4;
    if (!moved) {
      clearMediaPointerDrag();
      return;
    }

    const drop = getMediaDropAtPoint(event.clientX, event.clientY, timelineZoom, getTimelineDurationSeconds(timeline.durationUs));
    const targetTrack = drop ? timeline.tracks.find((track) => track.id === drop.trackId) : undefined;
    if (!drop || !targetTrack) {
      setStatusMessage(`Drop ${mediaDragState.asset.name} onto a ${mediaDragState.asset.kind} track`);
      clearMediaPointerDrag();
      return;
    }

    if (targetTrack.kind !== mediaDragState.asset.kind) {
      setStatusMessage(`${mediaDragState.asset.name} belongs on a ${mediaDragState.asset.kind} track`);
      clearMediaPointerDrag();
      return;
    }

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`);
      clearMediaPointerDrag();
      return;
    }

    const asset = mediaDragState.asset;
    clearMediaPointerDrag();
    void addMediaToTimeline(asset, targetTrack.id, drop.startUs);
  }

  function cancelMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (mediaDragState && event.currentTarget.hasPointerCapture(mediaDragState.pointerId)) {
      event.currentTarget.releasePointerCapture(mediaDragState.pointerId);
    }
    clearMediaPointerDrag();
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
          if (internalMediaDragRef.current) {
            return;
          }

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
    if (!playing) {
      if (playbackFrameRef.current !== null) {
        cancelAnimationFrame(playbackFrameRef.current);
        playbackFrameRef.current = null;
      }
      lastPlaybackTimeRef.current = null;
      return;
    }

    function tick(now: number) {
      if (lastPlaybackTimeRef.current === null) {
        lastPlaybackTimeRef.current = now;
      }

      const elapsedMs = now - lastPlaybackTimeRef.current;
      lastPlaybackTimeRef.current = now;
      setPlayheadUs((current) => {
        const next = current + Math.round(elapsedMs * 1000);
        const end = Math.max(timeline.durationUs, 1_000_000);
        if (next >= end) {
          stopPlayback();
          return end;
        }
        return next;
      });
      playbackFrameRef.current = requestAnimationFrame(tick);
    }

    playbackFrameRef.current = requestAnimationFrame(tick);
    return () => {
      if (playbackFrameRef.current !== null) {
        cancelAnimationFrame(playbackFrameRef.current);
        playbackFrameRef.current = null;
      }
    };
  }, [playing, timeline.durationUs]);

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
                  className={draggingMediaId === asset.id ? "media-card dragging" : "media-card"}
                  draggable={false}
                  onPointerDown={(event) => beginMediaPointerDrag(event, asset)}
                  onPointerMove={updateMediaPointerDrag}
                  onPointerUp={finishMediaPointerDrag}
                  onPointerCancel={cancelMediaPointerDrag}
                  onDoubleClick={() => addMediaToTimeline(asset)}
                >
                  <MediaThumbnail asset={asset} />
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
            <PreviewSurface
              previewUrl={previewUrl}
              videoAsset={activeVideoAsset}
              videoClip={activeVideoClip}
              audioAsset={activeAudioAsset}
              audioClip={activeAudioClip}
              playheadUs={playheadUs}
              playing={playing}
            />
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
              onMoveClip={moveClip}
              onTrimClip={trimClip}
              onToggleTrack={toggleTrack}
              draggingMediaId={draggingMediaId}
              mediaDropTrackId={mediaDropTrackId}
              onMediaDropTrackChange={setMediaDropTrackId}
              setStatusMessage={setStatusMessage}
            />
          </div>
        </Panel>
      </section>

      <Panel title="Clip Inspector" className="clip-inspector">
        {selectedClip ? <ClipInspector clip={selectedClip} /> : <div className="empty-state">Select a clip.</div>}
      </Panel>

      {mediaDragState?.active ? (
        <div className="media-drag-preview" style={{ transform: `translate(${mediaDragState.x + 14}px, ${mediaDragState.y + 14}px)` }}>
          <MediaThumbnail asset={mediaDragState.asset} />
          <span>{mediaDragState.asset.name}</span>
          <small>{mediaDragState.asset.kind.toUpperCase()} - {mediaDragState.asset.extension}</small>
        </div>
      ) : null}
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
  onMoveClip,
  onTrimClip,
  onToggleTrack,
  draggingMediaId,
  mediaDropTrackId,
  onMediaDropTrackChange,
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
  onMoveClip: (clipId: string, targetTrackId: string, startUs: number) => Promise<void>;
  onTrimClip: (clipId: string, edge: "start" | "end", deltaUs: number) => Promise<void>;
  onToggleTrack: (trackId: string, field: "locked" | "muted" | "visible") => void;
  draggingMediaId: string | null;
  mediaDropTrackId: string | null;
  onMediaDropTrackChange: (trackId: string | null) => void;
  setStatusMessage: (message: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const [clipInteraction, setClipInteraction] = useState<ClipInteraction | null>(null);
  const [previewClip, setPreviewClip] = useState<PreviewClipState | null>(null);
  const durationSeconds = getTimelineDurationSeconds(timeline.durationUs);
  const timelineWidth = Math.max(1200, durationSeconds * zoomPxPerSecond);
  const playheadLeft = timelineHeaderWidth + (playheadUs / 1_000_000) * zoomPxPerSecond;
  const marks = createTimeMarks(durationSeconds);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    const visibleLeft = scrollElement.scrollLeft;
    const visibleRight = visibleLeft + scrollElement.clientWidth;
    if (playheadLeft > visibleRight - 120) {
      scrollElement.scrollLeft = playheadLeft - scrollElement.clientWidth + 160;
    } else if (playheadLeft < visibleLeft + timelineHeaderWidth + 40) {
      scrollElement.scrollLeft = Math.max(0, playheadLeft - timelineHeaderWidth - 40);
    }
  }, [playheadLeft]);

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

  function beginClipInteraction(event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, mode: ClipInteraction["mode"]) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelectClip(clip.id);
    setClipInteraction({
      mode,
      clipId: clip.id,
      startClientX: event.clientX,
      originalStartUs: clip.startUs,
      originalInUs: clip.inUs,
      originalOutUs: clip.outUs,
      originalTrackId: clip.trackId
    });
    setPreviewClip({
      clipId: clip.id,
      startUs: clip.startUs,
      inUs: clip.inUs,
      outUs: clip.outUs,
      trackId: clip.trackId
    });
  }

  function updateClipInteraction(event: ReactPointerEvent<HTMLElement>) {
    if (!clipInteraction) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const deltaUs = Math.round(((event.clientX - clipInteraction.startClientX) / zoomPxPerSecond) * 1_000_000);
    if (clipInteraction.mode === "move") {
      setPreviewClip({
        clipId: clipInteraction.clipId,
        startUs: Math.max(0, clipInteraction.originalStartUs + deltaUs),
        inUs: clipInteraction.originalInUs,
        outUs: clipInteraction.originalOutUs,
        trackId: clipInteraction.originalTrackId
      });
      return;
    }

    if (clipInteraction.mode === "trim-start") {
      const nextInUs = Math.max(0, clipInteraction.originalInUs + deltaUs);
      const nextStartUs = Math.max(0, clipInteraction.originalStartUs + deltaUs);
      if (clipInteraction.originalOutUs - nextInUs <= 250_000) {
        return;
      }
      setPreviewClip({
        clipId: clipInteraction.clipId,
        startUs: nextStartUs,
        inUs: nextInUs,
        outUs: clipInteraction.originalOutUs,
        trackId: clipInteraction.originalTrackId
      });
      return;
    }

    const nextOutUs = Math.max(clipInteraction.originalInUs + 250_000, clipInteraction.originalOutUs + deltaUs);
    setPreviewClip({
      clipId: clipInteraction.clipId,
      startUs: clipInteraction.originalStartUs,
      inUs: clipInteraction.originalInUs,
      outUs: nextOutUs,
      trackId: clipInteraction.originalTrackId
    });
  }

  function finishClipInteraction(event: ReactPointerEvent<HTMLElement>) {
    if (!clipInteraction) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const deltaUs = Math.round(((event.clientX - clipInteraction.startClientX) / zoomPxPerSecond) * 1_000_000);
    if (clipInteraction.mode === "move") {
      const targetTrackId = getTrackIdAtPoint(event.clientX, event.clientY) ?? clipInteraction.originalTrackId;
      void onMoveClip(clipInteraction.clipId, targetTrackId, Math.max(0, clipInteraction.originalStartUs + deltaUs));
    } else {
      void onTrimClip(clipInteraction.clipId, clipInteraction.mode === "trim-start" ? "start" : "end", deltaUs);
    }

    setClipInteraction(null);
    setPreviewClip(null);
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
                <IconButton
                  label={track.locked ? "Unlock track" : "Lock track"}
                  icon={track.locked ? <Lock size={14} /> : <Unlock size={14} />}
                  className={track.locked ? "icon-active" : ""}
                  onClick={() => onToggleTrack(track.id, "locked")}
                />
                {track.kind === "audio" ? (
                  <IconButton
                    label={track.muted ? "Unmute track" : "Mute track"}
                    icon={track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    className={track.muted ? "icon-active" : ""}
                    onClick={() => onToggleTrack(track.id, "muted")}
                  />
                ) : (
                  <IconButton
                    label={track.visible ? "Hide track" : "Show track"}
                    icon={track.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    className={!track.visible ? "icon-active" : ""}
                    onClick={() => onToggleTrack(track.id, "visible")}
                  />
                )}
              </div>
            </div>
            <div
              data-track-id={track.id}
              className={mediaDropTrackId === track.id ? "track-lane media-drop-target" : "track-lane"}
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(event) => {
                event.preventDefault();
                const asset = mediaAssets.find((item) => item.id === draggingMediaId);
                event.dataTransfer.dropEffect = asset && asset.kind === track.kind && !track.locked ? "copy" : "none";
                onMediaDropTrackChange(track.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  onMediaDropTrackChange(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMediaDropTrackChange(null);
                const mediaId =
                  event.dataTransfer.getData("application/x-ai-video-media-id") ||
                  readMediaIdFromJsonDrop(event.dataTransfer.getData("application/json")) ||
                  event.dataTransfer.getData("text/plain");
                const asset = mediaAssets.find((item) => item.id === mediaId);
                if (!asset) {
                  setStatusMessage("Drop an imported media card from the media bin");
                  return;
                }

                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const startUs = Math.round(clamp(x / zoomPxPerSecond, 0, durationSeconds) * 1_000_000);
                void onAddMediaToTimeline(asset, track.id, startUs);
              }}
            >
              {track.clips.map((clip) => {
                const displayClip = previewClip?.clipId === clip.id ? { ...clip, ...previewClip } : clip;
                const start = (displayClip.startUs / 1_000_000) * zoomPxPerSecond;
                const width = Math.max(((displayClip.outUs - displayClip.inUs) / 1_000_000) * zoomPxPerSecond, 8);
                const mediaName = mediaAssets.find((asset) => asset.id === clip.mediaId)?.name ?? clip.mediaId;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={[
                      "timeline-clip",
                      track.kind,
                      clip.id === selectedClipId ? "selected" : "",
                      clipInteraction?.clipId === clip.id ? "dragging" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    data-tight={width < 56 ? "true" : undefined}
                    style={{ left: `${start}px`, width: `${width}px` }}
                    title={mediaName}
                    onPointerDown={(event) => beginClipInteraction(event, clip, "move")}
                    onPointerMove={updateClipInteraction}
                    onPointerUp={finishClipInteraction}
                    onPointerCancel={() => {
                      setClipInteraction(null);
                      setPreviewClip(null);
                    }}
                    onClick={() => onSelectClip(clip.id)}
                  >
                    <span
                      className="clip-trim-handle start"
                      onPointerDown={(event) => beginClipInteraction(event, clip, "trim-start")}
                      onPointerMove={updateClipInteraction}
                      onPointerUp={finishClipInteraction}
                      onPointerCancel={() => {
                        setClipInteraction(null);
                        setPreviewClip(null);
                      }}
                    />
                    <span>{mediaName}</span>
                    {track.kind === "audio" ? <VolumeX size={13} /> : null}
                    <span
                      className="clip-trim-handle end"
                      onPointerDown={(event) => beginClipInteraction(event, clip, "trim-end")}
                      onPointerMove={updateClipInteraction}
                      onPointerUp={finishClipInteraction}
                      onPointerCancel={() => {
                        setClipInteraction(null);
                        setPreviewClip(null);
                      }}
                    />
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

function PreviewSurface({
  previewUrl,
  videoAsset,
  videoClip,
  audioAsset,
  audioClip,
  playheadUs,
  playing
}: {
  previewUrl?: string;
  videoAsset?: MediaAsset;
  videoClip?: TimelineClip;
  audioAsset?: MediaAsset;
  audioClip?: TimelineClip;
  playheadUs: number;
  playing: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [videoSrc, setVideoSrc] = useState("");
  const [audioSrc, setAudioSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!videoAsset) {
      setVideoSrc("");
      return;
    }

    void getMediaSourceUrl(videoAsset.path).then((url) => {
      if (!cancelled) {
        setVideoSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [videoAsset]);

  useEffect(() => {
    let cancelled = false;
    if (!audioAsset || videoAsset) {
      setAudioSrc("");
      return;
    }

    void getMediaSourceUrl(audioAsset.path).then((url) => {
      if (!cancelled) {
        setAudioSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [audioAsset, videoAsset]);

  useEffect(() => {
    syncMediaElement(videoRef, videoClip, playheadUs, playing);
  }, [videoClip, playheadUs, playing, videoSrc]);

  useEffect(() => {
    syncMediaElement(audioRef, audioClip, playheadUs, playing);
  }, [audioClip, playheadUs, playing, audioSrc]);

  if (videoAsset && videoClip && videoSrc) {
    return (
      <div className="preview-frame has-media">
        <video ref={videoRef} src={videoSrc} muted={false} playsInline />
        <div className="preview-overlay">
          <span>{videoAsset.name}</span>
          <small>{formatTimelineTime(Math.max(0, Math.floor((playheadUs - videoClip.startUs) / 1_000_000)))}</small>
        </div>
      </div>
    );
  }

  if (audioAsset && audioClip && audioSrc) {
    return (
      <div className="preview-frame has-audio">
        <audio ref={audioRef} src={audioSrc} />
        <Music size={34} />
        <span>{audioAsset.name}</span>
        <small>{formatTimelineTime(Math.max(0, Math.floor((playheadUs - audioClip.startUs) / 1_000_000)))}</small>
      </div>
    );
  }

  return (
    <div className="preview-frame">
      <span>No clip at playhead</span>
      <small>{previewUrl ?? "Import media, add it to the timeline, then press Space."}</small>
    </div>
  );
}

const mediaThumbnailCache = new Map<string, string>();

function MediaThumbnail({ asset }: { asset: MediaAsset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const [thumbnailSrc, setThumbnailSrc] = useState("");
  const [loaded, setLoaded] = useState(asset.kind === "audio");

  useEffect(() => {
    let cancelled = false;
    function loadVideoFallback() {
      void getMediaSourceUrl(asset.path).then((url) => {
        if (!cancelled) {
          setSrc(url);
        }
      });
    }

    if (asset.kind !== "video") {
      setSrc("");
      setThumbnailSrc("");
      setLoaded(true);
      return;
    }

    setSrc("");
    setThumbnailSrc("");
    setLoaded(false);
    const cachedThumbnail = mediaThumbnailCache.get(asset.path);
    if (cachedThumbnail) {
      setThumbnailSrc(cachedThumbnail);
      setLoaded(true);
      return;
    }

    void getMediaThumbnailDataUrl(asset).then((url) => {
      if (!cancelled) {
        if (url) {
          mediaThumbnailCache.set(asset.path, url);
          setThumbnailSrc(url);
          setLoaded(true);
        } else {
          loadVideoFallback();
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      return;
    }
    const mediaElement = video;

    function handleMetadata() {
      try {
        mediaElement.currentTime = Math.min(0.25, Math.max(0, mediaElement.duration / 20));
      } catch {
        setLoaded(true);
      }
    }

    function handleLoadedData() {
      mediaElement.pause();
      setLoaded(true);
    }

    mediaElement.addEventListener("loadedmetadata", handleMetadata);
    mediaElement.addEventListener("loadeddata", handleLoadedData);
    return () => {
      mediaElement.removeEventListener("loadedmetadata", handleMetadata);
      mediaElement.removeEventListener("loadeddata", handleLoadedData);
    };
  }, [src]);

  if (asset.kind === "audio") {
    return (
      <span className="media-thumb-frame audio">
        <Music size={18} />
      </span>
    );
  }

  return (
    <span className={loaded ? "media-thumb-frame video loaded" : "media-thumb-frame video"}>
      {thumbnailSrc ? <img src={thumbnailSrc} alt="" /> : null}
      {!thumbnailSrc && src ? <video ref={videoRef} src={src} muted preload="metadata" playsInline /> : null}
      <Film size={18} />
    </span>
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

function findActiveClip(timeline: typeof starterTimeline, playheadUs: number, kind: "video" | "audio") {
  return timeline.tracks
    .filter((track) => track.kind === kind && !track.locked && (kind === "audio" ? !track.muted : track.visible))
    .flatMap((track) => track.clips)
    .find((clip) => playheadUs >= clip.startUs && playheadUs < clip.startUs + (clip.outUs - clip.inUs));
}

function syncMediaElement(
  ref: MutableRefObject<HTMLVideoElement | HTMLAudioElement | null>,
  clip: TimelineClip | undefined,
  playheadUs: number,
  playing: boolean
) {
  const element = ref.current;
  if (!element || !clip) {
    element?.pause();
    return;
  }

  const clipOffsetSeconds = Math.max(0, (playheadUs - clip.startUs + clip.inUs) / 1_000_000);
  if (Number.isFinite(clipOffsetSeconds) && Math.abs(element.currentTime - clipOffsetSeconds) > 0.18) {
    try {
      element.currentTime = clipOffsetSeconds;
    } catch {
      return;
    }
  }

  if (playing) {
    void element.play().catch(() => {
      // Browser/WebView codec or autoplay failures should not stop timeline playback.
    });
  } else {
    element.pause();
  }
}

function getTimelineDurationSeconds(durationUs: number) {
  return Math.max(60, Math.ceil(durationUs / 1_000_000));
}

function getMediaDropAtPoint(clientX: number, clientY: number, zoomPxPerSecond: number, durationSeconds: number) {
  const lane = document
    .elementsFromPoint(clientX, clientY)
    .map((element) => (element instanceof HTMLElement ? element.closest<HTMLElement>(".track-lane") : null))
    .find((element): element is HTMLElement => Boolean(element?.dataset.trackId));

  if (!lane?.dataset.trackId) {
    return null;
  }

  const rect = lane.getBoundingClientRect();
  const seconds = clamp((clientX - rect.left) / zoomPxPerSecond, 0, durationSeconds);
  return {
    trackId: lane.dataset.trackId,
    startUs: Math.round(seconds * 1_000_000)
  };
}

function getTrackIdAtPoint(clientX: number, clientY: number) {
  const lane = document
    .elementsFromPoint(clientX, clientY)
    .map((element) => (element instanceof HTMLElement ? element.closest<HTMLElement>(".track-lane") : null))
    .find((element): element is HTMLElement => Boolean(element?.dataset.trackId));
  return lane?.dataset.trackId;
}

function readMediaIdFromJsonDrop(value: string) {
  if (!value) {
    return "";
  }

  try {
    const data = JSON.parse(value) as { type?: string; id?: string };
    return data.type === "media-asset" ? data.id ?? "" : "";
  } catch {
    return "";
  }
}

function snapTime(valueUs: number) {
  return Math.max(0, Math.round(valueUs / snapIntervalUs) * snapIntervalUs);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
