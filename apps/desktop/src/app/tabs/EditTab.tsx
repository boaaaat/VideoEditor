import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  Eye,
  EyeOff,
  Film,
  Filter,
  FolderOpen,
  Import,
  Clipboard,
  ClipboardPaste,
  Copy,
  Link2,
  Lock,
  Magnet,
  Maximize2,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Scissors,
  Search,
  Shield,
  StepBack,
  StepForward,
  Trash2,
  Unlock,
  Unlink,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import {
  defaultAudioAdjustment,
  defaultClipEffects,
  defaultClipTransform,
  type AudioAdjustment,
  type ClipEffect,
  type ClipTransform,
  type ColorAdjustment,
  type CommandResult,
  type EditorCommand,
  type PreviewState,
  type ProjectSettings,
  type Timeline,
  type TimelineClip
} from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { ContextMenu, type ContextMenuItem } from "../../components/ContextMenu";
import { IconButton } from "../../components/IconButton";
import { Panel } from "../../components/Panel";
import { Toggle } from "../../components/Toggle";
import { executeCommand } from "../../features/commands/commandClient";
import { isTypingTarget, matchesShortcut, shortcutFor, type ShortcutMap } from "../../features/commands/shortcuts";
import type { LogStatus } from "../../features/logging/appLog";
import { importMediaPaths, type ImportMediaResult } from "../../features/media/importMedia";
import {
  getMediaDurationUs,
  getMediaCacheStatus,
  getMediaPreviewFrameDataUrl,
  getMediaSourceUrl,
  getMediaThumbnailDataUrl,
  getMediaWaveformDataUrl,
  isSupportedMediaPath,
  pathToMediaAsset,
  supportedMediaExtensions,
  type MediaCacheStatus,
  type MediaAsset
} from "../../features/media/mediaTypes";
import { probeMediaPath } from "../../features/media/importMedia";
import { starterTimeline } from "../../features/timeline/mockTimeline";
import {
  attachNativePreviewSurface,
  elementToNativePreviewRect,
  getNativePreviewStats,
  pauseNativePreview,
  playNativePreview,
  previewQualities,
  resizeNativePreviewSurface,
  seekNativePreview,
  setNativePreviewState,
  type PreviewQuality
} from "../../features/playback/preview";

const timelineHeaderWidth = 128;
const minTimelineZoom = 32;
const maxTimelineZoom = 180;
const timelineZoomStep = 8;
const minTimelineDurationUs = 10_000_000;
const timelineTailRoomUs = 10_000_000;
const maxRenderedMediaCards = 400;
const snapIntervalUs = 500_000;
const snapThresholdPx = 18;
const visualClipGapPx = 2;
const defaultVideoDurationUs = 8_000_000;
const defaultAudioDurationUs = 12_000_000;

interface MediaAudioGraph {
  element: HTMLMediaElement;
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
}

interface EditTabProps {
  previewUrl?: string;
  mediaAssets: MediaAsset[];
  timeline: Timeline;
  setTimeline: Dispatch<SetStateAction<Timeline>>;
  projectSettings: ProjectSettings;
  onImportMedia: () => Promise<void>;
  onImportMediaResult: (result: ImportMediaResult | null) => void;
  onRemoveMediaAsset: (assetId: string, data?: unknown) => void;
  onRenameMediaAsset: (assetId: string, nextName: string) => void;
  onRelinkMediaAsset: (assetId: string, asset: MediaAsset) => void;
  missingMediaPaths: string[];
  projectPath?: string;
  shortcuts: ShortcutMap;
  setStatusMessage: LogStatus;
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

interface ClipboardClip {
  clip: TimelineClip;
  offsetUs: number;
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

interface MediaDropPreviewState {
  trackId: string;
  startUs: number;
  durationUs: number;
  snapped: boolean;
  invalid: boolean;
}

type EditContextMenuState =
  | {
      kind: "media";
      assetId: string;
      x: number;
      y: number;
    }
  | {
      kind: "clip";
      clipId: string;
      x: number;
      y: number;
    };

type MediaTypeFilter = "all" | "video" | "audio" | "missing";
type MediaDurationFilter = "all" | "short" | "medium" | "long";
type MediaResolutionFilter = "all" | "hd" | "uhd" | "unknown";
type MediaFpsFilter = "all" | "24" | "30" | "60" | "unknown";
type MediaSortKey = "imported-desc" | "name-asc" | "name-desc" | "duration-desc" | "resolution-desc" | "fps-desc" | "type";
type PreviewScaleMode = "fit" | "50" | "100" | "150";

export function EditTab({
  previewUrl,
  mediaAssets,
  timeline,
  setTimeline,
  projectSettings,
  onImportMedia,
  onImportMediaResult,
  onRemoveMediaAsset,
  onRenameMediaAsset,
  onRelinkMediaAsset,
  missingMediaPaths,
  projectPath,
  shortcuts,
  setStatusMessage
}: EditTabProps) {
  const playbackFrameRef = useRef<number | null>(null);
  const lastPlaybackTimeRef = useRef<number | null>(null);
  const internalMediaDragRef = useRef(false);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [mediaDragOver, setMediaDragOver] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [soloTrackIds, setSoloTrackIds] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>("Proxy");
  const [previewScale, setPreviewScale] = useState<PreviewScaleMode>("fit");
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [playheadUs, setPlayheadUs] = useState(0);
  const [timelineClipboard, setTimelineClipboard] = useState<ClipboardClip[]>([]);
  const [draggingMediaId, setDraggingMediaId] = useState<string | null>(null);
  const [mediaDropTrackId, setMediaDropTrackId] = useState<string | null>(null);
  const [mediaDragState, setMediaDragState] = useState<MediaPointerDragState | null>(null);
  const [mediaDropPreview, setMediaDropPreview] = useState<MediaDropPreviewState | null>(null);
  const [contextMenu, setContextMenu] = useState<EditContextMenuState | null>(null);
  const [mediaSearch, setMediaSearch] = useState("");
  const [mediaTypeFilter, setMediaTypeFilter] = useState<MediaTypeFilter>("all");
  const [mediaDurationFilter, setMediaDurationFilter] = useState<MediaDurationFilter>("all");
  const [mediaResolutionFilter, setMediaResolutionFilter] = useState<MediaResolutionFilter>("all");
  const [mediaFpsFilter, setMediaFpsFilter] = useState<MediaFpsFilter>("all");
  const [mediaSort, setMediaSort] = useState<MediaSortKey>("imported-desc");
  const [renamingAssetId, setRenamingAssetId] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const selectedClipId = selectedClipIds.at(-1) ?? "";
  const selectedClip = timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedClipId);
  const contextMediaAsset = contextMenu?.kind === "media" ? mediaAssets.find((asset) => asset.id === contextMenu.assetId) : undefined;
  const contextClip = contextMenu?.kind === "clip" ? timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === contextMenu.clipId) : undefined;
  const activeVideoClip = findActiveClip(timeline, playheadUs, "video", soloTrackIds);
  const activeAudioClip = findActiveClip(timeline, playheadUs, "audio", soloTrackIds);
  const activeVideoAsset = activeVideoClip ? mediaAssets.find((asset) => asset.id === activeVideoClip.mediaId) : undefined;
  const activeAudioAsset = activeAudioClip ? mediaAssets.find((asset) => asset.id === activeAudioClip.mediaId) : undefined;
  const missingMediaSet = useMemo(() => new Set(missingMediaPaths), [missingMediaPaths]);
  const visibleMediaAssets = useMemo(
    () => filterAndSortMediaAssets(mediaAssets, {
      search: mediaSearch,
      type: mediaTypeFilter,
      duration: mediaDurationFilter,
      resolution: mediaResolutionFilter,
      fps: mediaFpsFilter,
      sort: mediaSort,
      missingPaths: missingMediaSet
    }),
    [mediaAssets, mediaSearch, mediaTypeFilter, mediaDurationFilter, mediaResolutionFilter, mediaFpsFilter, mediaSort, missingMediaSet]
  );
  const renderedMediaAssets = useMemo(() => visibleMediaAssets.slice(0, maxRenderedMediaCards), [visibleMediaAssets]);

  function applyEngineTimeline(data: unknown) {
    const nextTimeline = (data as { timeline?: Timeline } | undefined)?.timeline;
    if (nextTimeline?.tracks) {
      setTimeline(withTimelineEditDuration(nextTimeline));
      return true;
    }
    return false;
  }

  function lockedTrackNameForClip(clip: TimelineClip) {
    const track = timeline.tracks.find((item) => item.id === clip.trackId);
    return track?.locked ? track.name : "";
  }

  function getTimelineClips() {
    return timeline.tracks.flatMap((track) => track.clips);
  }

  function trackForClip(clip: TimelineClip) {
    return timeline.tracks.find((track) => track.id === clip.trackId);
  }

  function selectedClipsForAction(targetClip?: TimelineClip) {
    if (targetClip && !selectedClipIds.includes(targetClip.id)) {
      return [targetClip];
    }

    const selected = getTimelineClips().filter((clip) => selectedClipIds.includes(clip.id));
    return selected.length > 0 ? selected : targetClip ? [targetClip] : [];
  }

  function lockedTrackNameForClips(clips: TimelineClip[]) {
    return clips.map(lockedTrackNameForClip).find(Boolean) ?? "";
  }

  function selectClip(clipId: string, mode: "single" | "toggle" | "range" = "single") {
    if (mode === "toggle") {
      setSelectedClipIds((current) => (current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId]));
      return;
    }

    if (mode === "range" && selectedClipId) {
      const orderedClipIds = getTimelineClips()
        .sort(compareClipsByTimeline)
        .map((clip) => clip.id);
      const anchorIndex = orderedClipIds.indexOf(selectedClipId);
      const nextIndex = orderedClipIds.indexOf(clipId);
      if (anchorIndex >= 0 && nextIndex >= 0) {
        const [from, to] = anchorIndex < nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
        setSelectedClipIds(orderedClipIds.slice(from, to + 1));
        return;
      }
    }

    setSelectedClipIds([clipId]);
  }

  function clearClipSelection() {
    setSelectedClipIds([]);
  }

  async function runCommand(command: EditorCommand, fallbackError = "Command failed"): Promise<CommandResult> {
    try {
      return await executeCommand(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : fallbackError;
      setStatusMessage(message, { level: "error" });
      return { ok: false, error: message };
    }
  }

  async function splitAtPlayhead(targetClip?: TimelineClip) {
    const clip = targetClip ?? selectedClip;
    if (clip) {
      const lockedTrackName = lockedTrackNameForClip(clip);
      if (lockedTrackName) {
        setStatusMessage(`${lockedTrackName} is locked`, { level: "warning" });
        return;
      }
    }

    const result = await runCommand({ type: "split_clip", clipId: targetClip?.id, playheadUs }, "Split failed");
    const usedEngineTimeline = applyEngineTimeline(result.data);
    if (!usedEngineTimeline && clip && playheadUs > clip.startUs && playheadUs < clip.startUs + (clip.outUs - clip.inUs)) {
      const firstOutUs = clip.inUs + (playheadUs - clip.startUs);
      const secondDurationUs = clip.outUs - firstOutUs;
      const secondClip = {
        ...clip,
        id: `clip_${Date.now()}`,
        startUs: playheadUs,
        inUs: firstOutUs,
        outUs: firstOutUs + secondDurationUs
      };

      setTimeline((current) => withTimelineEditDuration({
        ...current,
        tracks: current.tracks.map((track) =>
          track.id === clip.trackId
            ? {
                ...track,
                clips: track.clips.flatMap((item) => (item.id === clip.id ? [{ ...item, outUs: firstOutUs }, secondClip] : [item]))
              }
            : track
        )
      }));
      setSelectedClipIds([secondClip.id]);
    }

    setStatusMessage(result.ok ? "Split command accepted" : result.error ?? "Split failed", { level: result.ok ? "success" : "error" });
  }

  async function addTrack(kind: "video" | "audio") {
    const result = await runCommand({ type: "add_track", kind }, "Add track failed");
    if (!applyEngineTimeline(result.data)) {
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
    }
    setStatusMessage(result.ok ? `Add ${kind} track command accepted` : result.error ?? "Add track failed", { level: result.ok ? "success" : "error" });
  }

  function toggleTrack(trackId: string, field: "locked" | "muted" | "visible" | "solo") {
    const track = timeline.tracks.find((item) => item.id === trackId);
    if (field === "solo") {
      setSoloTrackIds((current) => (current.includes(trackId) ? current.filter((id) => id !== trackId) : [...current, trackId]));
      if (track) {
        setStatusMessage(`${track.name} solo ${soloTrackIds.includes(trackId) ? "off" : "on"}`, { source: "timeline" });
      }
      return;
    }

    setTimeline((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (track.id === trackId ? { ...track, [field]: !track[field] } : track))
    }));
    if (track) {
      setStatusMessage(`${track.name} ${field} ${track[field] ? "off" : "on"}`);
    }
  }

  async function deleteSelectedClip(targetClip?: TimelineClip) {
    const clips = selectedClipsForAction(targetClip);
    if (clips.length === 0) {
      setStatusMessage("No clip selected", { level: "warning" });
      return;
    }

    const lockedTrackName = lockedTrackNameForClips(clips);
    if (lockedTrackName) {
      setStatusMessage(`${lockedTrackName} is locked`, { level: "warning" });
      return;
    }

    const results = await Promise.all(clips.map((clip) => runCommand({ type: "delete_clip", clipId: clip.id }, "Delete failed")));
    const lastResult = results.at(-1);
    if (!applyEngineTimeline(lastResult?.data)) {
      const deletedIds = new Set(clips.map((clip) => clip.id));
      setTimeline((current) => withTimelineEditDuration({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((item) => !deletedIds.has(item.id))
        }))
      }));
    }
    clearClipSelection();
    const failed = results.find((result) => !result.ok);
    setStatusMessage(failed ? failed.error ?? "Delete failed" : `Deleted ${clips.length} clip${clips.length === 1 ? "" : "s"}`, {
      level: failed ? "error" : "success"
    });
  }

  async function rippleDelete(targetClip?: TimelineClip) {
    const clips = selectedClipsForAction(targetClip);
    if (clips.length === 0) {
      setStatusMessage("No clip selected", { level: "warning" });
      return;
    }

    const lockedTrackName = lockedTrackNameForClips(clips);
    if (lockedTrackName) {
      setStatusMessage(`${lockedTrackName} is locked`, { level: "warning" });
      return;
    }

    const orderedClips = [...clips].sort(compareClipsByTimeline);
    const results = await Promise.all(orderedClips.map((clip) => runCommand({ type: "ripple_delete_clip", clipId: clip.id, trackMode: "selected_track" }, "Ripple delete failed")));
    const lastResult = results.at(-1);
    if (!applyEngineTimeline(lastResult?.data)) {
      setTimeline((current) => withTimelineEditDuration(rippleDeleteClips(current, orderedClips)));
    }
    clearClipSelection();
    const failed = results.find((result) => !result.ok);
    setStatusMessage(failed ? failed.error ?? "Ripple delete failed" : `Ripple deleted ${clips.length} clip${clips.length === 1 ? "" : "s"}`, {
      level: failed ? "error" : "success"
    });
  }

  function zoomTimeline(direction: -1 | 1) {
    setTimelineZoom((value) => clamp(value + direction * timelineZoomStep, minTimelineZoom, maxTimelineZoom));
  }

  function setTimelineZoomValue(value: number) {
    setTimelineZoom(clamp(value, minTimelineZoom, maxTimelineZoom));
  }

  function fitTimeline() {
    const durationSeconds = Math.max(1, Math.ceil(timeline.durationUs / 1_000_000));
    const fittedZoom = clamp(Math.floor(1100 / durationSeconds), minTimelineZoom, maxTimelineZoom);
    setTimelineZoom(fittedZoom);
  }

  function setPlayheadClamped(valueUs: number) {
    setPlayheadUs(clamp(valueUs, 0, Math.max(timeline.durationUs, 1_000_000)));
  }

  function stepPlayhead(direction: -1 | 1) {
    const frameDurationUs = Math.round(1_000_000 / Math.max(1, projectSettings.fps));
    const nextPlayheadUs = clamp(playheadUs + direction * frameDurationUs, 0, Math.max(timeline.durationUs, 1_000_000));
    setPlaying(false);
    setPlayheadUs(nextPlayheadUs);
    setStatusMessage(direction < 0 ? "Stepped back one frame" : "Stepped forward one frame", {
      source: "timeline",
      details: { playheadUs: nextPlayheadUs, frameDurationUs }
    });
  }

  function stopPlayback() {
    setPlaying(false);
    if (playbackFrameRef.current !== null) {
      cancelAnimationFrame(playbackFrameRef.current);
      playbackFrameRef.current = null;
    }
    lastPlaybackTimeRef.current = null;
  }

  async function nudgeSelectedClip(direction: -1 | 1, targetClip?: TimelineClip) {
    const clips = selectedClipsForAction(targetClip);
    if (clips.length === 0) {
      setStatusMessage("No clip selected", { level: "warning" });
      return;
    }

    const lockedTrackName = lockedTrackNameForClips(clips);
    if (lockedTrackName) {
      setStatusMessage(`${lockedTrackName} is locked`, { level: "warning" });
      return;
    }

    const moved = clips.map((clip) => ({ ...clip, startUs: Math.max(0, clip.startUs + direction * 100_000) }));
    const results = await Promise.all(
      moved.map((clip) =>
        runCommand({
          type: "move_clip",
          clipId: clip.id,
          trackId: clip.trackId,
          startUs: clip.startUs,
          snapping
        }, "Nudge failed")
      )
    );
    const lastResult = results.at(-1);
    if (!applyEngineTimeline(lastResult?.data)) {
      const movedById = new Map(moved.map((clip) => [clip.id, clip]));
      setTimeline((current) => ({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((item) => movedById.get(item.id) ?? item).sort((left, right) => left.startUs - right.startUs)
        }))
      }));
    }
    const failed = results.find((result) => !result.ok);
    setStatusMessage(failed ? failed.error ?? "Nudge failed" : `Nudged ${clips.length} clip${clips.length === 1 ? "" : "s"}`, {
      level: failed ? "error" : "success"
    });
  }

  async function moveClip(clipId: string, targetTrackId: string, startUs: number) {
    const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    const targetTrack = timeline.tracks.find((track) => track.id === targetTrackId);
    if (!clip || !targetTrack) {
      return;
    }

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`, { level: "warning" });
      return;
    }

    const sourceAsset = mediaAssets.find((asset) => asset.id === clip.mediaId);
    if (sourceAsset && !canMediaAssetUseTrack(sourceAsset, targetTrack.kind)) {
      setStatusMessage(`${sourceAsset.name} cannot be used on a ${targetTrack.kind} track`, { level: "warning" });
      return;
    }

    const nextStartUs = snapping ? resolveTrackSnapStart(timeline, targetTrackId, startUs, timelineZoom, clipId, false).startUs : Math.max(0, startUs);
    const selectedMoveClips = selectedClipIds.includes(clipId) ? selectedClipsForAction(clip) : [clip];
    const lockedTrackName = lockedTrackNameForClips(selectedMoveClips);
    if (lockedTrackName) {
      setStatusMessage(`${lockedTrackName} is locked`, { level: "warning" });
      return;
    }

    const deltaUs = nextStartUs - clip.startUs;
    const movedClips = selectedMoveClips.map((item) => ({
      ...item,
      trackId: item.id === clipId ? targetTrackId : item.trackId,
      startUs: Math.max(0, item.startUs + deltaUs)
    }));
    const invalidMovedClip = movedClips.find((item) => {
      const track = timeline.tracks.find((candidate) => candidate.id === item.trackId);
      const asset = mediaAssets.find((candidate) => candidate.id === item.mediaId);
      return !track || track.locked || (asset && !canMediaAssetUseTrack(asset, track.kind));
    });
    if (invalidMovedClip) {
      setStatusMessage("Move blocked by track type or lock state", { level: "warning" });
      return;
    }

    const results = await Promise.all(
      movedClips.map((item) =>
        runCommand({
          type: "move_clip",
          clipId: item.id,
          trackId: item.trackId,
          startUs: item.startUs,
          snapping
        }, "Move clip failed")
      )
    );
    const lastResult = results.at(-1);
    if (!applyEngineTimeline(lastResult?.data)) {
      const movedById = new Map(movedClips.map((item) => [item.id, item]));
      setTimeline((current) => {
        return withTimelineEditDuration({
          ...current,
          tracks: current.tracks.map((track) => ({
            ...track,
            clips: [
              ...track.clips.filter((item) => !movedById.has(item.id)),
              ...movedClips.filter((item) => item.trackId === track.id)
            ].sort((left, right) => left.startUs - right.startUs)
          }))
        });
      });
    }
    setSelectedClipIds(selectedMoveClips.map((item) => item.id));
    const failed = results.find((result) => !result.ok);
    setStatusMessage(failed ? failed.error ?? "Move clip failed" : `Moved ${movedClips.length} clip${movedClips.length === 1 ? "" : "s"}`, {
      level: failed ? "error" : "success"
    });
  }

  async function trimClip(clipId: string, edge: "start" | "end", deltaUs: number) {
    const clip = timeline.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
    if (!clip) {
      return;
    }

    const track = timeline.tracks.find((item) => item.id === clip.trackId);
    if (track?.locked) {
      setStatusMessage(`${track.name} is locked`, { level: "warning" });
      return;
    }

    const minDurationUs = 250_000;
    let nextClip = clip;
    if (edge === "start") {
      const nextStartUs = Math.max(0, clip.startUs + deltaUs);
      const resolvedStartUs = snapping ? resolveTrackSnapStart(timeline, clip.trackId, nextStartUs, timelineZoom, clip.id, false).startUs : nextStartUs;
      const nextInUs = Math.max(0, clip.inUs + (resolvedStartUs - clip.startUs));
      if (clip.outUs - nextInUs < minDurationUs) {
        return;
      }
      nextClip = { ...clip, startUs: resolvedStartUs, inUs: nextInUs };
    } else {
      const nextOutUs = Math.max(clip.inUs + minDurationUs, clip.outUs + deltaUs);
      const clipEndUs = clip.startUs + (nextOutUs - clip.inUs);
      const resolvedEndUs = snapping ? resolveTrackSnapStart(timeline, clip.trackId, clipEndUs, timelineZoom, clip.id, false).startUs : clipEndUs;
      nextClip = { ...clip, outUs: Math.max(clip.inUs + minDurationUs, clip.inUs + resolvedEndUs - clip.startUs) };
    }

    const result = await runCommand({
      type: "trim_clip",
      clipId,
      edge,
      timeUs: edge === "start" ? nextClip.startUs : nextClip.outUs
    }, "Trim failed");
    if (!applyEngineTimeline(result.data)) {
      setTimeline((current) => withTimelineEditDuration({
        ...current,
        tracks: current.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((item) => (item.id === clipId ? nextClip : item))
        }))
      }));
    }
    setSelectedClipIds([clipId]);
    setStatusMessage(result.ok ? "Trimmed clip" : result.error ?? "Trim failed", { level: result.ok ? "success" : "error" });
  }

  async function addMediaToTimeline(asset: MediaAsset, targetTrackId?: string, startUs = playheadUs) {
    const targetTrack = targetTrackId
      ? timeline.tracks.find((track) => track.id === targetTrackId)
      : timeline.tracks.find((track) => track.kind === asset.kind && track.name.endsWith("1")) ?? timeline.tracks.find((track) => track.kind === asset.kind);

    if (!targetTrack) {
      setStatusMessage(`Add an ${asset.kind} track first`, { level: "warning" });
      return;
    }

    if (!canMediaAssetUseTrack(asset, targetTrack.kind)) {
      setStatusMessage(`${asset.name} cannot be used on an ${targetTrack.kind} track`, { level: "warning" });
      return;
    }

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`, { level: "warning" });
      return;
    }

    const fallbackDurationUs = getFallbackMediaDurationUs(asset);
    const nextStartUs = targetTrackId
      ? Math.max(0, startUs)
      : resolveMediaDropPlacement(timeline, asset, targetTrack.id, getTrackEndUs(targetTrack), timelineZoom, snapping).startUs;
    const clipId = `clip_${Date.now()}`;
    const newClip = {
      id: clipId,
      mediaId: asset.id,
      trackId: targetTrack.id,
      startUs: nextStartUs,
      inUs: 0,
      outUs: fallbackDurationUs,
      color: {
        brightness: 0,
        contrast: 0,
        saturation: 1,
        temperature: 0,
        tint: 0
      }
    };

    setTimeline((current) => withTimelineEditDuration({
      ...current,
      tracks: current.tracks.map((track) =>
        track.id === targetTrack.id
          ? {
              ...track,
              clips: [...track.clips, newClip].sort((left, right) => left.startUs - right.startUs)
            }
          : track
      )
    }));
    setSelectedClipIds([clipId]);
    setStatusMessage(`Added ${asset.name} to timeline`, { level: "success", details: { mediaId: asset.id, clipId, trackId: targetTrack.id } });

    void runCommand({
      type: "add_clip",
      clipId,
      mediaId: asset.id,
      trackId: targetTrack.id,
      startUs: nextStartUs,
      inUs: 0,
      outUs: fallbackDurationUs
    }, "Add clip failed").then((result) => {
      if (!result.ok) {
        setStatusMessage(result.error ?? "Add clip failed", { level: "error" });
        return;
      }
      applyEngineTimeline(result.data);
    });

    void getMediaDurationUs(asset, fallbackDurationUs);
  }

  async function importDroppedPaths(paths: string[]) {
    if (internalMediaDragRef.current) {
      return;
    }

    const supported = paths.filter(isSupportedMediaPath);
    if (supported.length === 0) {
      if (paths.length > 0) {
        setStatusMessage("No supported media dropped", { level: "warning", source: "media" });
      }
      return;
    }

    try {
      onImportMediaResult(await importMediaPaths(supported));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Dropped media import failed", { level: "error", source: "media" });
    }
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
    setMediaDropPreview(null);
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
    setStatusMessage(`Drag ${asset.name} onto a ${asset.kind} track`, { source: "media" });
  }

  function updateMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!mediaDragState || event.pointerId !== mediaDragState.pointerId) {
      return;
    }

    event.preventDefault();
    const moved = Math.hypot(event.clientX - mediaDragState.originX, event.clientY - mediaDragState.originY) > 4;
    const active = mediaDragState.active || moved;
    const drop = active ? getMediaDropAtPoint(event.clientX, event.clientY, timelineZoom, getTimelineDurationSeconds(timeline.durationUs)) : null;
    const preview = drop
      ? resolveMediaDropPlacement(timeline, mediaDragState.asset, drop.trackId, drop.startUs, timelineZoom, snapping)
      : null;

    setMediaDragState({
      ...mediaDragState,
      x: event.clientX,
      y: event.clientY,
      active
    });
    setDraggingMediaId(active ? mediaDragState.asset.id : null);
    setMediaDropTrackId(drop?.trackId ?? null);
    setMediaDropPreview(preview);
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
    const placement = drop ? resolveMediaDropPlacement(timeline, mediaDragState.asset, drop.trackId, drop.startUs, timelineZoom, snapping) : null;
    const targetTrack = placement ? timeline.tracks.find((track) => track.id === placement.trackId) : undefined;
    if (!drop || !targetTrack) {
      setStatusMessage(`Drop ${mediaDragState.asset.name} onto a compatible track`, { level: "warning", source: "media" });
      clearMediaPointerDrag();
      return;
    }

    if (!canMediaAssetUseTrack(mediaDragState.asset, targetTrack.kind)) {
      setStatusMessage(`${mediaDragState.asset.name} cannot be used on a ${targetTrack.kind} track`, { level: "warning", source: "media" });
      clearMediaPointerDrag();
      return;
    }

    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`, { level: "warning" });
      clearMediaPointerDrag();
      return;
    }

    const asset = mediaDragState.asset;
    clearMediaPointerDrag();
    void addMediaToTimeline(asset, targetTrack.id, placement?.startUs ?? drop.startUs);
  }

  function cancelMediaPointerDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    if (mediaDragState && event.currentTarget.hasPointerCapture(mediaDragState.pointerId)) {
      event.currentTarget.releasePointerCapture(mediaDragState.pointerId);
    }
    clearMediaPointerDrag();
  }

  function openMediaContextMenu(event: ReactMouseEvent<HTMLButtonElement>, asset: MediaAsset) {
    event.preventDefault();
    event.stopPropagation();
    clearMediaPointerDrag();
    setContextMenu({
      kind: "media",
      assetId: asset.id,
      x: event.clientX,
      y: event.clientY
    });
  }

  function openClipContextMenu(event: ReactMouseEvent, clip: TimelineClip) {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedClipIds.includes(clip.id)) {
      setSelectedClipIds([clip.id]);
    }
    setContextMenu({
      kind: "clip",
      clipId: clip.id,
      x: event.clientX,
      y: event.clientY
    });
  }

  async function revealMediaInExplorer(asset: MediaAsset) {
    if (!("__TAURI_INTERNALS__" in window)) {
      setStatusMessage("Reveal in Explorer is available in the desktop app", { level: "warning", source: "media" });
      return;
    }

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reveal_media_path", { path: asset.path });
      setStatusMessage(`Revealed ${asset.name} in Explorer`, { level: "success", source: "media", details: { path: asset.path } });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Reveal in Explorer failed", { level: "error", source: "media" });
    }
  }

  function startRenamingMedia(asset: MediaAsset) {
    setRenamingAssetId(asset.id);
    setRenameDraft(asset.name);
    setStatusMessage(`Renaming ${asset.name}`, { source: "media" });
  }

  function commitMediaRename() {
    if (!renamingAssetId) {
      return;
    }

    onRenameMediaAsset(renamingAssetId, renameDraft);
    setRenamingAssetId("");
    setRenameDraft("");
  }

  function cancelMediaRename() {
    setRenamingAssetId("");
    setRenameDraft("");
  }

  async function relinkMedia(asset: MediaAsset) {
    if (!("__TAURI_INTERNALS__" in window)) {
      setStatusMessage("Relink media is available in the desktop app", { level: "warning", source: "media" });
      return;
    }

    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selection = await open({
        multiple: false,
        title: `Relink ${asset.name}`,
        filters: [{ name: "Media", extensions: [...supportedMediaExtensions] }]
      });
      if (!selection || Array.isArray(selection)) {
        return;
      }
      if (!isSupportedMediaPath(selection)) {
        setStatusMessage("Selected file type is not supported", { level: "warning", source: "media", details: { path: selection } });
        return;
      }

      const metadata = await probeMediaPath(selection).catch(() => undefined);
      const relinkedAsset = {
        ...pathToMediaAsset(selection, metadata),
        id: asset.id,
        name: asset.name,
        importedAt: asset.importedAt,
        intelligence: asset.intelligence
      };
      onRelinkMediaAsset(asset.id, relinkedAsset);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Relink media failed", { level: "error", source: "media" });
    }
  }

  async function removeMediaFromBin(asset: MediaAsset) {
    const removedClipCount = timeline.tracks.reduce((count, track) => count + track.clips.filter((clip) => clip.mediaId === asset.id).length, 0);
    const result = await runCommand({ type: "remove_media", mediaId: asset.id }, "Remove media failed");
    if (!result.ok) {
      setStatusMessage(result.error ?? "Remove media failed", { level: "error", source: "media" });
      return;
    }

    onRemoveMediaAsset(asset.id, result.data);
    setSelectedClipIds((current) => current.filter((clipId) => !timeline.tracks.some((track) => track.clips.some((clip) => clip.id === clipId && clip.mediaId === asset.id))));

    const suffix = removedClipCount > 0 ? ` and ${removedClipCount} timeline clip${removedClipCount === 1 ? "" : "s"}` : "";
    setStatusMessage(`Removed ${asset.name} from bin${suffix}`, {
      level: "success",
      source: "media",
      details: { mediaId: asset.id, removedClipCount, sourceFileDeleted: false }
    });
  }

  function copySelectedClips(targetClip?: TimelineClip) {
    const clips = selectedClipsForAction(targetClip).sort(compareClipsByTimeline);
    if (clips.length === 0) {
      setStatusMessage("No clip selected", { level: "warning", source: "timeline" });
      return [];
    }

    const firstStartUs = Math.min(...clips.map((clip) => clip.startUs));
    const nextClipboard = clips.map((clip) => ({
      clip,
      offsetUs: clip.startUs - firstStartUs
    }));
    setTimelineClipboard(nextClipboard);
    setStatusMessage(`Copied ${clips.length} clip${clips.length === 1 ? "" : "s"}`, { source: "timeline" });
    return nextClipboard;
  }

  async function cutSelectedClips(targetClip?: TimelineClip) {
    const copied = copySelectedClips(targetClip);
    if (copied.length > 0) {
      await deleteSelectedClip(targetClip);
      setStatusMessage(`Cut ${copied.length} clip${copied.length === 1 ? "" : "s"}`, { level: "success", source: "timeline" });
    }
  }

  function duplicateSelectedClips(targetClip?: TimelineClip) {
    const clips = selectedClipsForAction(targetClip).sort(compareClipsByTimeline);
    if (clips.length === 0) {
      setStatusMessage("No clip selected", { level: "warning", source: "timeline" });
      return;
    }

    const lockedTrackName = lockedTrackNameForClips(clips);
    if (lockedTrackName) {
      setStatusMessage(`${lockedTrackName} is locked`, { level: "warning", source: "timeline" });
      return;
    }

    const duplicateOffsetUs = Math.max(...clips.map((clip) => clip.startUs + (clip.outUs - clip.inUs))) - Math.min(...clips.map((clip) => clip.startUs)) + snapIntervalUs;
    insertTimelineClips(
      clips.map((clip, index) => ({
        ...clip,
        id: `clip_${Date.now()}_${index}`,
        startUs: snapTime(clip.startUs + duplicateOffsetUs)
      })),
      "Duplicated"
    );
  }

  function pasteTimelineClips() {
    if (timelineClipboard.length === 0) {
      setStatusMessage("Timeline clipboard is empty", { level: "warning", source: "timeline" });
      return;
    }

    const pasteStartUs = snapping ? snapTime(playheadUs) : playheadUs;
    const nextClips = timelineClipboard.map((item, index) => ({
      ...item.clip,
      id: `clip_${Date.now()}_${index}`,
      startUs: pasteStartUs + item.offsetUs
    }));
    insertTimelineClips(nextClips, "Pasted");
  }

  function insertTimelineClips(clips: TimelineClip[], actionLabel: string) {
    const blockedTrack = clips
      .map((clip) => timeline.tracks.find((track) => track.id === clip.trackId))
      .find((track) => track?.locked);
    if (blockedTrack) {
      setStatusMessage(`${blockedTrack.name} is locked`, { level: "warning", source: "timeline" });
      return;
    }

    setTimeline((current) => withTimelineEditDuration({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: [...track.clips, ...clips.filter((clip) => clip.trackId === track.id)].sort((left, right) => left.startUs - right.startUs)
      }))
    }));
    setSelectedClipIds(clips.map((clip) => clip.id));
    setStatusMessage(`${actionLabel} ${clips.length} clip${clips.length === 1 ? "" : "s"}`, {
      level: "success",
      source: "timeline",
      details: { clipIds: clips.map((clip) => clip.id) }
    });

    void Promise.all(
      clips.map((clip) =>
        runCommand({
          type: "add_clip",
          clipId: clip.id,
          mediaId: clip.mediaId,
          trackId: clip.trackId,
          startUs: clip.startUs,
          inUs: clip.inUs,
          outUs: clip.outUs
        }, `${actionLabel} clip failed`)
      )
    ).then((results) => {
      const lastResult = results.at(-1);
      if (lastResult?.ok) {
        applyEngineTimeline(lastResult.data);
      }
    });
  }

  async function detachClipAudio(clip: TimelineClip) {
    const sourceTrack = trackForClip(clip);
    const asset = mediaAssets.find((item) => item.id === clip.mediaId);
    if (!sourceTrack || sourceTrack.kind !== "video" || !asset?.metadata?.hasAudio) {
      setStatusMessage("Selected clip has no detachable audio", { level: "warning", source: "audio" });
      return;
    }

    const targetTrack =
      timeline.tracks.find((track) => track.kind === "audio" && !track.locked) ??
      timeline.tracks.find((track) => track.kind === "audio");
    if (!targetTrack) {
      setStatusMessage("Add an audio track before detaching audio", { level: "warning", source: "audio" });
      return;
    }
    if (targetTrack.locked) {
      setStatusMessage(`${targetTrack.name} is locked`, { level: "warning", source: "audio" });
      return;
    }

    const detachedAudio = {
      ...defaultAudioAdjustment,
      ...clip.audio,
      muted: false
    };
    const detachedClip: TimelineClip = {
      ...clip,
      id: `audio_${clip.id}_${Date.now()}`,
      trackId: targetTrack.id,
      audio: detachedAudio
    };
    const mutedSourceClip: TimelineClip = {
      ...clip,
      audio: {
        ...defaultAudioAdjustment,
        ...clip.audio,
        muted: true
      }
    };

    setTimeline((current) => withTimelineEditDuration({
      ...current,
      tracks: current.tracks.map((track) => {
        if (track.id === sourceTrack.id) {
          return {
            ...track,
            clips: track.clips.map((item) => (item.id === clip.id ? mutedSourceClip : item))
          };
        }
        if (track.id === targetTrack.id) {
          return {
            ...track,
            clips: [...track.clips, detachedClip].sort((left, right) => left.startUs - right.startUs)
          };
        }
        return track;
      })
    }));
    setSelectedClipIds([detachedClip.id]);

    const muteResult = await runCommand({ type: "apply_audio_adjustment", clipId: clip.id, adjustment: { muted: true } }, "Mute source clip failed");
    const addResult = await runCommand({
      type: "add_clip",
      clipId: detachedClip.id,
      mediaId: detachedClip.mediaId,
      trackId: detachedClip.trackId,
      startUs: detachedClip.startUs,
      inUs: detachedClip.inUs,
      outUs: detachedClip.outUs
    }, "Detach audio failed");
    const audioResult = await runCommand({
      type: "apply_audio_adjustment",
      clipId: detachedClip.id,
      adjustment: detachedAudio
    }, "Detached audio settings failed");
    if (audioResult.ok) {
      applyEngineTimeline(audioResult.data);
    } else if (addResult.ok) {
      applyEngineTimeline(addResult.data);
    }
    const failed = [muteResult, addResult, audioResult].find((result) => !result.ok);
    setStatusMessage(failed ? failed.error ?? "Detach audio failed" : `Detached audio from ${asset.name}`, {
      level: failed ? "error" : "success",
      source: "audio",
      details: { sourceClipId: clip.id, audioClipId: detachedClip.id, trackId: targetTrack.id }
    });
  }

  function contextMenuItems(): ContextMenuItem[] {
    if (contextMenu?.kind === "media" && contextMediaAsset) {
      const canReveal = "__TAURI_INTERNALS__" in window;
      return [
        {
          id: "add-to-timeline",
          label: "Add to Timeline",
          icon: <Plus size={15} />,
          onSelect: () => void addMediaToTimeline(contextMediaAsset)
        },
        {
          id: "rename-bin-item",
          label: "Rename in Bin",
          icon: <Pencil size={15} />,
          onSelect: () => startRenamingMedia(contextMediaAsset)
        },
        {
          id: "relink-media",
          label: "Relink Media",
          icon: <Link2 size={15} />,
          disabled: !canReveal,
          onSelect: () => void relinkMedia(contextMediaAsset)
        },
        {
          id: "reveal-in-explorer",
          label: "Reveal in Explorer",
          icon: <FolderOpen size={15} />,
          disabled: !canReveal,
          onSelect: () => void revealMediaInExplorer(contextMediaAsset)
        },
        {
          id: "remove-from-bin",
          label: "Remove From Bin",
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => void removeMediaFromBin(contextMediaAsset)
        }
      ];
    }

    if (contextMenu?.kind === "clip" && contextClip) {
      const playheadInsideClip = isPlayheadInsideClip(contextClip, playheadUs);
      const contextTrack = trackForClip(contextClip);
      const contextAsset = mediaAssets.find((asset) => asset.id === contextClip.mediaId);
      const canDetachAudio = contextTrack?.kind === "video" && Boolean(contextAsset?.metadata?.hasAudio);
      return [
        {
          id: "split-at-playhead",
          label: "Split at Playhead",
          icon: <Scissors size={15} />,
          disabled: !playheadInsideClip,
          onSelect: () => void splitAtPlayhead(contextClip)
        },
        {
          id: "copy-clip",
          label: selectedClipIds.includes(contextClip.id) && selectedClipIds.length > 1 ? "Copy Selection" : "Copy Clip",
          icon: <Copy size={15} />,
          onSelect: () => copySelectedClips(contextClip)
        },
        {
          id: "cut-clip",
          label: selectedClipIds.includes(contextClip.id) && selectedClipIds.length > 1 ? "Cut Selection" : "Cut Clip",
          icon: <Scissors size={15} />,
          onSelect: () => void cutSelectedClips(contextClip)
        },
        {
          id: "duplicate-clip",
          label: selectedClipIds.includes(contextClip.id) && selectedClipIds.length > 1 ? "Duplicate Selection" : "Duplicate Clip",
          icon: <Clipboard size={15} />,
          onSelect: () => duplicateSelectedClips(contextClip)
        },
        {
          id: "detach-audio",
          label: "Detach Audio",
          icon: <Unlink size={15} />,
          disabled: !canDetachAudio,
          onSelect: () => void detachClipAudio(contextClip)
        },
        {
          id: "paste-clips",
          label: "Paste at Playhead",
          icon: <ClipboardPaste size={15} />,
          disabled: timelineClipboard.length === 0,
          onSelect: pasteTimelineClips
        },
        {
          id: "delete-clip",
          label: selectedClipIds.includes(contextClip.id) && selectedClipIds.length > 1 ? "Delete Selection" : "Delete Clip",
          icon: <Trash2 size={15} />,
          onSelect: () => void deleteSelectedClip(contextClip)
        },
        {
          id: "ripple-delete",
          label: "Ripple Delete",
          icon: <Trash2 size={15} />,
          danger: true,
          onSelect: () => void rippleDelete(contextClip)
        },
        {
          id: "nudge-left",
          label: "Nudge Left",
          icon: <StepBack size={15} />,
          onSelect: () => void nudgeSelectedClip(-1, contextClip)
        },
        {
          id: "nudge-right",
          label: "Nudge Right",
          icon: <StepForward size={15} />,
          onSelect: () => void nudgeSelectedClip(1, contextClip)
        }
      ];
    }

    return [];
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
    setPlayheadUs((current) => clamp(current, 0, Math.max(timeline.durationUs, 1_000_000)));
  }, [timeline.durationUs]);

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
          if (loopPlayback) {
            return 0;
          }
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
  }, [loopPlayback, playing, timeline.durationUs]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "play_pause"))) {
        event.preventDefault();
        setPlaying((value) => !value);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        setLoopPlayback((value) => !value);
        setStatusMessage(`Loop playback ${loopPlayback ? "off" : "on"}`, { source: "timeline" });
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        stepPlayhead(-1);
        return;
      }

      if (!event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        stepPlayhead(1);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedClipIds(getTimelineClips().map((clip) => clip.id));
        setStatusMessage("Selected all timeline clips", { source: "timeline" });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        copySelectedClips();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
        event.preventDefault();
        void cutSelectedClips();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteTimelineClips();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedClips();
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "split"))) {
        event.preventDefault();
        void splitAtPlayhead();
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "delete")) || matchesShortcut(event, shortcutFor(shortcuts, "ripple_delete"))) {
        event.preventDefault();
        if (matchesShortcut(event, shortcutFor(shortcuts, "ripple_delete"))) {
          void rippleDelete();
        } else {
          void deleteSelectedClip();
        }
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "toggle_snapping"))) {
        event.preventDefault();
        setSnapping((value) => !value);
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "nudge_left"))) {
        event.preventDefault();
        void nudgeSelectedClip(-1);
        return;
      }

      if (matchesShortcut(event, shortcutFor(shortcuts, "nudge_right"))) {
        event.preventDefault();
        void nudgeSelectedClip(1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loopPlayback, playheadUs, projectSettings.fps, selectedClip, selectedClipIds, shortcuts, snapping, timeline, timelineClipboard]);

  return (
    <div className="edit-workspace">
      <Panel title="Media Bin" className="media-bin">
        <div className="media-bin-tools">
          <div className="media-bin-primary-row">
            <label className="media-search">
              <Search size={15} />
              <input value={mediaSearch} onChange={(event) => setMediaSearch(event.target.value)} placeholder="Search media" />
            </label>
            <Button icon={<Import size={16} />} variant="primary" onClick={onImportMedia}>
              Import
            </Button>
          </div>
          <div className="media-filter-row">
            <select value={mediaTypeFilter} aria-label="Filter media type" onChange={(event) => setMediaTypeFilter(event.target.value as MediaTypeFilter)}>
              <option value="all">All types</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="missing">Missing</option>
            </select>
            <select value={mediaSort} aria-label="Sort media" onChange={(event) => setMediaSort(event.target.value as MediaSortKey)}>
              <option value="imported-desc">Newest</option>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
              <option value="duration-desc">Duration</option>
              <option value="resolution-desc">Resolution</option>
              <option value="fps-desc">FPS</option>
              <option value="type">Type</option>
            </select>
          </div>
          <div className="media-filter-row compact">
            <select value={mediaDurationFilter} aria-label="Filter duration" onChange={(event) => setMediaDurationFilter(event.target.value as MediaDurationFilter)}>
              <option value="all">Any duration</option>
              <option value="short">Under 1m</option>
              <option value="medium">1-10m</option>
              <option value="long">Over 10m</option>
            </select>
            <select value={mediaResolutionFilter} aria-label="Filter resolution" onChange={(event) => setMediaResolutionFilter(event.target.value as MediaResolutionFilter)}>
              <option value="all">Any resolution</option>
              <option value="hd">HD</option>
              <option value="uhd">UHD+</option>
              <option value="unknown">Unknown res</option>
            </select>
            <select value={mediaFpsFilter} aria-label="Filter frame rate" onChange={(event) => setMediaFpsFilter(event.target.value as MediaFpsFilter)}>
              <option value="all">Any fps</option>
              <option value="24">24/25</option>
              <option value="30">30</option>
              <option value="60">50/60+</option>
              <option value="unknown">Unknown fps</option>
            </select>
          </div>
          <div className="media-bin-summary">
            <span>
              <Filter size={13} />
              {visibleMediaAssets.length}/{mediaAssets.length}
            </span>
            {missingMediaPaths.length > 0 ? <span className="media-status-danger">{missingMediaPaths.length} missing</span> : null}
          </div>
        </div>
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
              {renderedMediaAssets.map((asset) => {
                const missing = missingMediaSet.has(asset.path);
                return (
                  <div key={asset.id} className={["media-card-shell", missing ? "missing" : ""].filter(Boolean).join(" ")}>
                    {renamingAssetId === asset.id ? (
                      <div className="media-card media-card-edit">
                        <MediaThumbnail asset={asset} />
                        <input
                          className="media-rename-input"
                          value={renameDraft}
                          autoFocus
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onPointerDown={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              commitMediaRename();
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelMediaRename();
                            }
                          }}
                          onBlur={cancelMediaRename}
                        />
                        <small>Enter to rename</small>
                        <MediaManagementStatus asset={asset} projectPath={projectPath} missing={missing} />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className={draggingMediaId === asset.id ? "media-card dragging" : "media-card"}
                        draggable={false}
                        onPointerDown={(event) => beginMediaPointerDrag(event, asset)}
                        onPointerMove={updateMediaPointerDrag}
                        onPointerUp={finishMediaPointerDrag}
                        onPointerCancel={cancelMediaPointerDrag}
                        onContextMenu={(event) => openMediaContextMenu(event, asset)}
                        onDoubleClick={() => addMediaToTimeline(asset)}
                      >
                        <MediaThumbnail asset={asset} />
                        <span>{asset.name}</span>
                        <small>{formatMediaAssetDetail(asset)}</small>
                        <MediaManagementStatus asset={asset} projectPath={projectPath} missing={missing} />
                      </button>
                      )}
                  </div>
                );
              })}
              {visibleMediaAssets.length > renderedMediaAssets.length ? (
                <div className="media-empty filtered">
                  Showing {renderedMediaAssets.length} of {visibleMediaAssets.length}. Narrow filters or search to render fewer cards.
                </div>
              ) : null}
              {visibleMediaAssets.length === 0 ? <div className="media-empty filtered">No media matches the current filters.</div> : null}
            </div>
          ) : (
            <div className="media-empty">
              <Import size={24} />
            </div>
          )}
        </div>
      </Panel>

      <section className="preview-and-timeline">
        <Panel
          title="Preview"
          actions={
            <>
              <select value={previewQuality} aria-label="Preview quality" onChange={(event) => setPreviewQuality(event.target.value as PreviewQuality)}>
                {previewQualities.map((quality) => (
                  <option key={quality}>{quality}</option>
                ))}
              </select>
              <select value={previewScale} aria-label="Preview scale" onChange={(event) => setPreviewScale(event.target.value as PreviewScaleMode)}>
                <option value="fit">Fit</option>
                <option value="50">50%</option>
                <option value="100">100%</option>
                <option value="150">150%</option>
              </select>
            </>
          }
        >
          <div className="preview-player">
            <PreviewSurface
              previewUrl={previewUrl}
              videoAsset={activeVideoAsset}
              videoClip={activeVideoClip}
              audioAsset={activeAudioAsset}
              audioClip={activeAudioClip}
              projectSettings={projectSettings}
              previewQuality={previewQuality}
              previewScale={previewScale}
              playheadUs={playheadUs}
              playing={playing}
            />
            <div className="transport">
              <IconButton label={playing ? "Pause" : "Play"} icon={playing ? <Pause size={18} /> : <Play size={18} />} onClick={() => setPlaying((value) => !value)} />
              <IconButton label="Step back one frame" icon={<StepBack size={17} />} onClick={() => stepPlayhead(-1)} />
              <IconButton label="Step forward one frame" icon={<StepForward size={17} />} onClick={() => stepPlayhead(1)} />
              <IconButton label={loopPlayback ? "Loop playback on" : "Loop playback off"} icon={<Repeat size={17} />} className={loopPlayback ? "icon-active" : ""} onClick={() => setLoopPlayback((value) => !value)} />
              <IconButton label="Copy clips" icon={<Copy size={17} />} disabled={selectedClipIds.length === 0} onClick={() => copySelectedClips()} />
              <IconButton label="Paste clips" icon={<ClipboardPaste size={17} />} disabled={timelineClipboard.length === 0} onClick={pasteTimelineClips} />
              <Button icon={<Scissors size={16} />} onClick={() => void splitAtPlayhead()}>
                Split
              </Button>
              <Button icon={<Trash2 size={16} />} onClick={() => void deleteSelectedClip()}>
                Delete
              </Button>
              <Button icon={<Trash2 size={16} />} variant="danger" onClick={() => void rippleDelete()}>
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
              <IconButton label="Copy clips" icon={<Copy size={17} />} disabled={selectedClipIds.length === 0} onClick={() => copySelectedClips()} />
              <IconButton label="Paste clips" icon={<ClipboardPaste size={17} />} disabled={timelineClipboard.length === 0} onClick={pasteTimelineClips} />
              <IconButton label="Duplicate clips" icon={<Clipboard size={17} />} disabled={selectedClipIds.length === 0} onClick={() => duplicateSelectedClips()} />
              <Button icon={<Scissors size={16} />} onClick={() => void splitAtPlayhead()}>
                Split
              </Button>
              <Button icon={<Trash2 size={16} />} onClick={() => void deleteSelectedClip()}>
                Delete
              </Button>
              <Button icon={<Trash2 size={16} />} variant="danger" onClick={() => void rippleDelete()}>
                Ripple
              </Button>
              <IconButton label="Nudge left" icon={<StepBack size={17} />} onClick={() => nudgeSelectedClip(-1)} />
              <IconButton label="Nudge right" icon={<StepForward size={17} />} onClick={() => nudgeSelectedClip(1)} />
              <IconButton label="Fit timeline" icon={<Maximize2 size={17} />} onClick={fitTimeline} />
              <Toggle label="Snapping" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />
              {selectedClipIds.length > 1 ? <span className="timeline-selection-count">{selectedClipIds.length} selected</span> : null}
              <span className="timeline-timecode">{formatTimelineTime(Math.floor(playheadUs / 1_000_000))}</span>
            </div>
            <TimelineSurface
              timeline={timeline}
              mediaAssets={mediaAssets}
              selectedClipIds={selectedClipIds}
              soloTrackIds={soloTrackIds}
              onSelectClip={selectClip}
              onClearSelection={clearClipSelection}
              playheadUs={playheadUs}
              onPlayheadChange={setPlayheadUs}
              zoomPxPerSecond={timelineZoom}
              snapping={snapping}
              onZoom={zoomTimeline}
              onZoomTo={setTimelineZoomValue}
              onAddMediaToTimeline={addMediaToTimeline}
              onMoveClip={moveClip}
              onTrimClip={trimClip}
              onOpenClipContextMenu={openClipContextMenu}
              onToggleTrack={toggleTrack}
              draggingMediaId={draggingMediaId}
              mediaDropTrackId={mediaDropTrackId}
              mediaDropPreview={mediaDropPreview}
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
          <small>{formatMediaAssetDetail(mediaDragState.asset)}</small>
        </div>
      ) : null}

      {contextMenu ? <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenuItems()} onClose={() => setContextMenu(null)} /> : null}
    </div>
  );
}

function TimelineSurface({
  timeline,
  mediaAssets,
  selectedClipIds,
  soloTrackIds,
  onSelectClip,
  onClearSelection,
  playheadUs,
  onPlayheadChange,
  zoomPxPerSecond,
  snapping,
  onZoom,
  onZoomTo,
  onAddMediaToTimeline,
  onMoveClip,
  onTrimClip,
  onOpenClipContextMenu,
  onToggleTrack,
  draggingMediaId,
  mediaDropTrackId,
  mediaDropPreview,
  onMediaDropTrackChange,
  setStatusMessage
}: {
  timeline: typeof starterTimeline;
  mediaAssets: MediaAsset[];
  selectedClipIds: string[];
  soloTrackIds: string[];
  onSelectClip: (clipId: string, mode?: "single" | "toggle" | "range") => void;
  onClearSelection: () => void;
  playheadUs: number;
  onPlayheadChange: (playheadUs: number) => void;
  zoomPxPerSecond: number;
  snapping: boolean;
  onZoom: (direction: -1 | 1) => void;
  onZoomTo: (zoomPxPerSecond: number) => void;
  onAddMediaToTimeline: (asset: MediaAsset, targetTrackId?: string, startUs?: number) => Promise<void>;
  onMoveClip: (clipId: string, targetTrackId: string, startUs: number) => Promise<void>;
  onTrimClip: (clipId: string, edge: "start" | "end", deltaUs: number) => Promise<void>;
  onOpenClipContextMenu: (event: ReactMouseEvent, clip: TimelineClip) => void;
  onToggleTrack: (trackId: string, field: "locked" | "muted" | "visible" | "solo") => void;
  draggingMediaId: string | null;
  mediaDropTrackId: string | null;
  mediaDropPreview: MediaDropPreviewState | null;
  onMediaDropTrackChange: (trackId: string | null) => void;
  setStatusMessage: LogStatus;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastWheelModeRef = useRef("");
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const [clipInteraction, setClipInteraction] = useState<ClipInteraction | null>(null);
  const [previewClip, setPreviewClip] = useState<PreviewClipState | null>(null);
  const [visibleTimelineRange, setVisibleTimelineRange] = useState({ left: 0, right: 2400 });
  const durationSeconds = getTimelineDurationSeconds(timeline.durationUs);
  const timelineWidth = Math.max(1200, durationSeconds * zoomPxPerSecond);
  const playheadLeft = timelineHeaderWidth + (playheadUs / 1_000_000) * zoomPxPerSecond;
  const marks = createTimeMarks(durationSeconds);
  const mediaById = useMemo(() => new Map(mediaAssets.map((asset) => [asset.id, asset])), [mediaAssets]);
  const visibleLaneStartPx = Math.max(0, visibleTimelineRange.left - timelineHeaderWidth);
  const visibleLaneEndPx = Math.max(0, visibleTimelineRange.right - timelineHeaderWidth);

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

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }

    updateVisibleTimelineRange(scrollElement);
    const resizeObserver = new ResizeObserver(() => updateVisibleTimelineRange(scrollElement));
    resizeObserver.observe(scrollElement);
    return () => resizeObserver.disconnect();
  }, [timelineWidth]);

  function updateVisibleTimelineRange(scrollElement: HTMLDivElement) {
    const overscanPx = 900;
    setVisibleTimelineRange({
      left: Math.max(0, scrollElement.scrollLeft - overscanPx),
      right: scrollElement.scrollLeft + scrollElement.clientWidth + overscanPx
    });
  }

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

    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      onClearSelection();
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
    event.preventDefault();
    if (event.shiftKey || event.ctrlKey) {
      const mode = event.ctrlKey ? "ctrl-zoom" : "shift-zoom";
      if (lastWheelModeRef.current !== mode) {
        lastWheelModeRef.current = mode;
        setStatusMessage(event.ctrlKey ? "Timeline zoom with Ctrl+wheel" : "Timeline zoom with Shift+wheel");
      }

      const direction = event.deltaY > 0 ? -1 : 1;
      const nextZoom = clamp(zoomPxPerSecond + direction * timelineZoomStep, minTimelineZoom, maxTimelineZoom);
      if (nextZoom === zoomPxPerSecond) {
        return;
      }

      const scrollElement = event.currentTarget;
      const rect = scrollElement.getBoundingClientRect();
      const anchorX = event.clientX - rect.left + scrollElement.scrollLeft - timelineHeaderWidth;
      const anchorSeconds = clamp(anchorX / zoomPxPerSecond, 0, durationSeconds);
      onZoomTo(nextZoom);
      requestAnimationFrame(() => {
        scrollElement.scrollLeft = Math.max(0, anchorSeconds * nextZoom - (event.clientX - rect.left) + timelineHeaderWidth);
      });
      return;
    }

    // Plain wheel always pans the timeline horizontally. Shift/Ctrl wheel zooms around
    // the cursor anchor above; status logging is limited to mode changes by lastWheelModeRef.
    if (lastWheelModeRef.current !== "pan") {
      lastWheelModeRef.current = "pan";
      setStatusMessage("Timeline wheel panning");
    }
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    event.currentTarget.scrollLeft += horizontalDelta;
  }

  function beginClipInteraction(event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, mode: ClipInteraction["mode"]) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.shiftKey) {
      onSelectClip(clip.id, "range");
    } else if (event.ctrlKey || event.metaKey) {
      onSelectClip(clip.id, "toggle");
    } else if (!selectedClipIds.includes(clip.id)) {
      onSelectClip(clip.id, "single");
    }
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
      const rawStartUs = Math.max(0, clipInteraction.originalStartUs + deltaUs);
      const resolved = snapping
        ? resolveTrackSnapStart(timeline, clipInteraction.originalTrackId, rawStartUs, zoomPxPerSecond, clipInteraction.clipId, false)
        : { startUs: rawStartUs, snapped: false };
      setPreviewClip({
        clipId: clipInteraction.clipId,
        startUs: resolved.startUs,
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
      const rawStartUs = Math.max(0, clipInteraction.originalStartUs + deltaUs);
      const resolved = snapping ? resolveTrackSnapStart(timeline, targetTrackId, rawStartUs, zoomPxPerSecond, clipInteraction.clipId, false) : { startUs: rawStartUs, snapped: false };
      void onMoveClip(clipInteraction.clipId, targetTrackId, resolved.startUs);
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
      onScroll={(event) => updateVisibleTimelineRange(event.currentTarget)}
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
        {timeline.tracks.map((track) => {
          const soloActive = soloTrackIds.length > 0;
          const trackSoloed = soloTrackIds.includes(track.id);
          const trackAudibleVisible = (track.kind === "audio" ? !track.muted : track.visible) && (!soloActive || trackSoloed);
          return (
          <div
            className={[
              "track-row",
              track.locked ? "track-locked" : "",
              trackSoloed ? "track-soloed" : "",
              !trackAudibleVisible ? "track-dimmed" : ""
            ].filter(Boolean).join(" ")}
            key={track.id}
            style={{ gridTemplateColumns: `${timelineHeaderWidth}px ${timelineWidth}px` }}
          >
            <div className="track-header">
              <span>{track.name}</span>
              <div>
                <IconButton
                  label={track.locked ? "Unlock track" : "Lock track"}
                  icon={track.locked ? <Lock size={14} /> : <Unlock size={14} />}
                  className={track.locked ? "icon-active" : ""}
                  onClick={() => onToggleTrack(track.id, "locked")}
                />
                <IconButton
                  label={soloTrackIds.includes(track.id) ? "Unsolo track" : "Solo track"}
                  icon={<Shield size={14} />}
                  className={soloTrackIds.includes(track.id) ? "icon-active" : ""}
                  onClick={() => onToggleTrack(track.id, "solo")}
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
              className={[
                "track-lane",
                mediaDropTrackId === track.id ? "media-drop-target" : "",
                mediaDropPreview?.trackId === track.id && mediaDropPreview.invalid ? "media-drop-invalid" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ width: `${timelineWidth}px` }}
              onDragOver={(event) => {
                event.preventDefault();
                const asset = draggingMediaId ? mediaById.get(draggingMediaId) : undefined;
                event.dataTransfer.dropEffect = asset && canMediaAssetUseTrack(asset, track.kind) && !track.locked ? "copy" : "none";
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
                const asset = mediaById.get(mediaId);
                if (!asset) {
                  setStatusMessage("Drop an imported media card from the media bin", { level: "warning", source: "media" });
                  return;
                }

                const rect = event.currentTarget.getBoundingClientRect();
                const x = event.clientX - rect.left;
                const rawStartUs = Math.round(clamp(x / zoomPxPerSecond, 0, durationSeconds) * 1_000_000);
                const placement = resolveMediaDropPlacement(timeline, asset, track.id, rawStartUs, zoomPxPerSecond, snapping);
                void onAddMediaToTimeline(asset, track.id, placement.startUs);
              }}
            >
              {mediaDropPreview?.trackId === track.id && !mediaDropPreview.invalid ? (
                <>
                  {mediaDropPreview.snapped ? (
                    <span className="timeline-snap-line" style={{ left: `${(mediaDropPreview.startUs / 1_000_000) * zoomPxPerSecond}px` }} />
                  ) : null}
                  <div
                    className={["timeline-clip", "media-drop-preview-clip", track.kind, mediaDropPreview.snapped ? "snapped" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: `${getClipVisualLeft(mediaDropPreview.startUs, zoomPxPerSecond)}px`,
                      width: `${getClipVisualWidth(mediaDropPreview.durationUs, zoomPxPerSecond)}px`
                    }}
                  >
                    <span>{draggingMediaId ? mediaById.get(draggingMediaId)?.name ?? "New clip" : "New clip"}</span>
                    {track.kind === "audio" ? <VolumeX size={13} /> : null}
                  </div>
                </>
              ) : null}
              {track.clips.filter((clip) => {
                if (selectedClipIds.includes(clip.id) || clipInteraction?.clipId === clip.id) {
                  return true;
                }
                const displayClip = previewClip?.clipId === clip.id ? { ...clip, ...previewClip } : clip;
                const start = getClipVisualLeft(displayClip.startUs, zoomPxPerSecond);
                const end = start + getClipVisualWidth(displayClip.outUs - displayClip.inUs, zoomPxPerSecond);
                return end >= visibleLaneStartPx && start <= visibleLaneEndPx;
              }).map((clip) => {
                const displayClip = previewClip?.clipId === clip.id ? { ...clip, ...previewClip } : clip;
                const durationUs = displayClip.outUs - displayClip.inUs;
                const start = getClipVisualLeft(displayClip.startUs, zoomPxPerSecond);
                const width = getClipVisualWidth(durationUs, zoomPxPerSecond);
                const mediaAsset = mediaById.get(clip.mediaId);
                const mediaName = mediaAsset?.name ?? clip.mediaId;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={[
                      "timeline-clip",
                      track.kind,
                      selectedClipIds.includes(clip.id) ? "selected" : "",
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
                    onContextMenu={(event) => onOpenClipContextMenu(event, clip)}
                    onClick={(event) => {
                      if (event.shiftKey) {
                        onSelectClip(clip.id, "range");
                      } else if (event.ctrlKey || event.metaKey) {
                        onSelectClip(clip.id, "toggle");
                      } else if (!selectedClipIds.includes(clip.id)) {
                        onSelectClip(clip.id, "single");
                      }
                    }}
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
                    {track.kind === "audio" && mediaAsset ? <TimelineClipWaveform asset={mediaAsset} /> : null}
                    <span className="timeline-clip-label">{mediaName}</span>
                    {track.kind === "audio" ? <Volume2 size={13} /> : null}
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
        );
        })}
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
  projectSettings,
  previewQuality,
  previewScale,
  playheadUs,
  playing
}: {
  previewUrl?: string;
  videoAsset?: MediaAsset;
  videoClip?: TimelineClip;
  audioAsset?: MediaAsset;
  audioClip?: TimelineClip;
  projectSettings: ProjectSettings;
  previewQuality: PreviewQuality;
  previewScale: PreviewScaleMode;
  playheadUs: number;
  playing: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoAudioGraphRef = useRef<MediaAudioGraph | null>(null);
  const audioAudioGraphRef = useRef<MediaAudioGraph | null>(null);
  const [videoSrc, setVideoSrc] = useState("");
  const [audioSrc, setAudioSrc] = useState("");
  const [frameSrc, setFrameSrc] = useState("");
  const [stats, setStats] = useState<PreviewState | null>(null);
  const separateAudioPreviewActive = Boolean(audioAsset && audioClip);

  useEffect(() => {
    const element = frameRef.current;
    if (!element || !videoAsset || separateAudioPreviewActive) {
      void pauseNativePreview().catch(() => undefined);
      return;
    }

    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    async function attach() {
      const target = frameRef.current;
      if (!target) {
        return;
      }

      const nextStats = await attachNativePreviewSurface(elementToNativePreviewRect(target));
      if (!cancelled) {
        setStats(nextStats);
      }
    }

    function resize() {
      const target = frameRef.current;
      if (!target) {
        return;
      }
      void resizeNativePreviewSurface(elementToNativePreviewRect(target)).then((nextStats) => {
        if (!cancelled) {
          setStats(nextStats);
        }
      });
    }

    void attach();
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    window.addEventListener("resize", resize);

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [separateAudioPreviewActive, videoAsset]);

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
    if (!audioAsset) {
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
  }, [audioAsset]);

  const previewFrameTimeUs = videoAsset && videoClip ? quantizePreviewFrameTime(getClipMediaTimeUs(videoClip, playheadUs)) : 0;

  useEffect(() => {
    let cancelled = false;
    if (!videoAsset || !videoClip || playing) {
      setFrameSrc("");
      return;
    }

    void getMediaPreviewFrameDataUrl(videoAsset, previewFrameTimeUs).then((url) => {
      if (!cancelled && url) {
        setFrameSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [playing, previewFrameTimeUs, videoAsset, videoClip]);

  useEffect(() => {
    const nativeMediaActive = !separateAudioPreviewActive;
    void setNativePreviewState({
      mediaId: nativeMediaActive ? videoAsset?.id ?? audioAsset?.id ?? "" : "",
      mediaPath: nativeMediaActive ? videoAsset?.path ?? audioAsset?.path ?? "" : "",
      codec: nativeMediaActive ? videoAsset?.metadata?.codec ?? audioAsset?.metadata?.codec ?? "unknown" : "unknown",
      quality: previewQuality,
      scale: previewScale,
      colorMode: projectSettings.colorMode,
      fps: projectSettings.fps,
      playheadUs,
      inUs: videoClip?.inUs ?? audioClip?.inUs ?? 0,
      outUs: videoClip?.outUs ?? audioClip?.outUs ?? 0,
      playing: nativeMediaActive && playing
    }).then(setStats).catch(() => undefined);
  }, [audioAsset, audioClip, playheadUs, playing, previewQuality, previewScale, projectSettings.colorMode, projectSettings.fps, separateAudioPreviewActive, videoAsset, videoClip]);

  useEffect(() => {
    void (playing && !separateAudioPreviewActive ? playNativePreview() : pauseNativePreview()).then(setStats).catch(() => undefined);
  }, [playing, separateAudioPreviewActive]);

  useEffect(() => {
    void seekNativePreview(playheadUs).then(setStats).catch(() => undefined);
  }, [playheadUs]);

  useEffect(() => {
    syncMediaElement(videoRef, videoClip, playheadUs, playing);
    applyMediaElementAudio(videoRef, videoAudioGraphRef, videoClip, projectSettings, playheadUs, playing);
  }, [videoClip, playheadUs, playing, videoSrc, projectSettings, stats?.childHwnd, separateAudioPreviewActive]);

  useEffect(() => {
    syncMediaElement(audioRef, audioClip, playheadUs, playing);
    applyMediaElementAudio(audioRef, audioAudioGraphRef, audioClip, projectSettings, playheadUs, playing);
  }, [audioClip, playheadUs, playing, audioSrc, projectSettings, separateAudioPreviewActive]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void getNativePreviewStats().then(setStats).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(interval);
  }, []);

  const activeAsset = videoAsset ?? audioAsset;
  const activeClip = videoClip ?? audioClip;
  const activeTime = activeClip ? formatTimelineTime(Math.max(0, Math.floor((playheadUs - activeClip.startUs) / 1_000_000))) : "";
  const displayedPreviewFps = playing ? Math.round(stats?.previewFps || projectSettings.fps) : Math.round(stats?.previewFps ?? 0);
  const previewScaleStyle = getPreviewScaleStyle(previewScale, projectSettings);
  const visualPreviewStyle = getClipVisualPreviewStyle(videoClip, previewScaleStyle);
  const nativePreviewActive = Boolean(stats?.childHwnd) && !clipHasVisualEdits(videoClip) && !separateAudioPreviewActive;
  const frameClassName = activeAsset
    ? nativePreviewActive
      ? "preview-frame has-native"
      : videoAsset
        ? "preview-frame has-media"
        : "preview-frame has-audio"
    : "preview-frame";

  return (
    <div ref={frameRef} className={frameClassName}>
      {nativePreviewActive ? <div className="native-preview-surface" style={previewScaleStyle} /> : null}
      {!nativePreviewActive && videoAsset && videoClip && videoSrc ? (
        <video ref={videoRef} src={videoSrc} muted={false} playsInline style={visualPreviewStyle} onLoadedMetadata={() => syncMediaElement(videoRef, videoClip, playheadUs, playing)} />
      ) : null}
      {nativePreviewActive && videoAsset && videoClip && videoSrc ? (
        <video
          ref={videoRef}
          src={videoSrc}
          muted={false}
          playsInline
          preload="auto"
          aria-hidden="true"
          tabIndex={-1}
          style={hiddenAudioCarrierStyle}
          onLoadedMetadata={() => syncMediaElement(videoRef, videoClip, playheadUs, playing)}
        />
      ) : null}
      {!nativePreviewActive && frameSrc && (!playing || !videoSrc) ? <img className="preview-frame-image" src={frameSrc} alt="" style={visualPreviewStyle} /> : null}
      {!nativePreviewActive && audioAsset && audioClip && audioSrc ? (
        <>
          <audio ref={audioRef} src={audioSrc} onLoadedMetadata={() => syncMediaElement(audioRef, audioClip, playheadUs, playing)} />
          {!videoAsset ? <Music size={34} /> : null}
        </>
      ) : null}
      {activeAsset && activeClip ? (
        <div className="preview-overlay">
          <span>{activeAsset.name}</span>
          <small>{activeTime}</small>
        </div>
      ) : (
        <div className="preview-empty-copy">
          <span>No clip at playhead</span>
          <small>{previewUrl ?? "Import media, add it to the timeline, then press Space."}</small>
        </div>
      )}
      <div className="preview-stats">
        <span>{stats?.codec ?? activeAsset?.metadata?.codec ?? "unknown"}</span>
        <span>{stats?.decodeMode ?? "idle"}</span>
        <span>{displayedPreviewFps} fps</span>
        <span>{stats?.droppedFrames ?? 0} dropped</span>
      </div>
      {stats?.warning ? <div className="preview-warning">{stats.warning}</div> : null}
    </div>
  );
}

const hiddenAudioCarrierStyle: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: "none"
};

const mediaThumbnailCache = new Map<string, string>();
const mediaWaveformCache = new Map<string, string>();

function MediaThumbnail({ asset }: { asset: MediaAsset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState("");
  const [thumbnailSrc, setThumbnailSrc] = useState("");
  const [waveformSrc, setWaveformSrc] = useState("");
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

  useEffect(() => {
    let cancelled = false;
    setWaveformSrc("");
    const cachedWaveform = mediaWaveformCache.get(asset.path);
    if (cachedWaveform) {
      setWaveformSrc(cachedWaveform);
      return;
    }

    void getMediaWaveformDataUrl(asset).then((url) => {
      if (!cancelled && url) {
        mediaWaveformCache.set(asset.path, url);
        setWaveformSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  if (asset.kind === "audio") {
    return (
      <span className="media-thumb-frame audio">
        {waveformSrc ? <img src={waveformSrc} alt="" /> : null}
        <Music size={18} />
      </span>
    );
  }

  return (
    <span className={loaded ? "media-thumb-frame video loaded" : "media-thumb-frame video"}>
      {thumbnailSrc ? <img src={thumbnailSrc} alt="" /> : null}
      {!thumbnailSrc && src ? <video ref={videoRef} src={src} muted preload="metadata" playsInline /> : null}
      {waveformSrc ? <img className="media-waveform-strip" src={waveformSrc} alt="" /> : null}
      <Film size={18} />
    </span>
  );
}

function TimelineClipWaveform({ asset }: { asset: MediaAsset }) {
  const [waveformSrc, setWaveformSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    setWaveformSrc("");
    const cachedWaveform = mediaWaveformCache.get(asset.path);
    if (cachedWaveform) {
      setWaveformSrc(cachedWaveform);
      return;
    }

    void getMediaWaveformDataUrl(asset).then((url) => {
      if (!cancelled && url) {
        mediaWaveformCache.set(asset.path, url);
        setWaveformSrc(url);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  if (waveformSrc) {
    return <img className="timeline-clip-waveform" src={waveformSrc} alt="" draggable={false} />;
  }

  return (
    <span className="timeline-clip-waveform fallback" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function MediaManagementStatus({ asset, projectPath, missing }: { asset: MediaAsset; projectPath?: string; missing: boolean }) {
  const [cacheStatus, setCacheStatus] = useState<MediaCacheStatus>(() => ({
    thumbnail: asset.kind === "video" ? "ready-on-demand" : "not-applicable",
    waveform: asset.kind === "audio" || asset.metadata?.hasAudio ? "ready-on-demand" : "not-applicable",
    proxy: "unavailable"
  }));

  useEffect(() => {
    let cancelled = false;
    void getMediaCacheStatus(asset, projectPath).then((status) => {
      if (!cancelled) {
        setCacheStatus(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [asset, projectPath]);

  return (
    <span className="media-management-status">
      <span className={missing ? "media-status-danger" : "media-status-ok"}>{missing ? "Missing" : "Linked"}</span>
      <span>{statusLabel("Thumb", cacheStatus.thumbnail)}</span>
      <span>{statusLabel("Wave", cacheStatus.waveform)}</span>
      <span className={cacheStatus.proxy === "missing" || cacheStatus.proxy === "error" ? "media-status-warning" : ""}>
        {statusLabel("Proxy", cacheStatus.proxy)}
      </span>
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

function getPreviewScaleStyle(previewScale: PreviewScaleMode, projectSettings: ProjectSettings): CSSProperties | undefined {
  if (previewScale === "fit") {
    return undefined;
  }

  const scale = Number(previewScale) / 100;
  return {
    width: `${Math.max(1, Math.round(projectSettings.width * scale))}px`,
    height: `${Math.max(1, Math.round(projectSettings.height * scale))}px`,
    maxWidth: "none",
    maxHeight: "none",
    objectFit: "contain"
  };
}

function getClipVisualPreviewStyle(clip: TimelineClip | undefined, baseStyle: CSSProperties | undefined): CSSProperties | undefined {
  if (!clip) {
    return baseStyle;
  }

  const transform = normalizeTransform(clip.transform);
  const effects = normalizeEffects(clip.effects);
  const style: CSSProperties = {
    ...baseStyle,
    filter: buildCssFilter(clip.color, clip.lut, effects),
    opacity: transform.enabled ? transform.opacity : 1
  };

  if (transform.enabled) {
    const baseTransform = baseStyle?.transform ? `${baseStyle.transform} ` : "";
    style.transform = `${baseTransform}translate(${transform.positionX}px, ${transform.positionY}px) rotate(${transform.rotation}deg) scale(${transform.scale})`;
  }
  return style;
}

function clipHasVisualEdits(clip: TimelineClip | undefined) {
  if (!clip) {
    return false;
  }
  const color = normalizeColor(clip.color);
  const transform = normalizeTransform(clip.transform);
  const effects = normalizeEffects(clip.effects);
  return (
    Math.abs(color.brightness) > 0.001 ||
    Math.abs(color.contrast) > 0.001 ||
    Math.abs(color.saturation - 1) > 0.001 ||
    Math.abs(color.temperature) > 0.001 ||
    Math.abs(color.tint) > 0.001 ||
    Boolean(clip.lut?.lutId && (clip.lut.strength ?? 0) > 0) ||
    (transform.enabled &&
      (Math.abs(transform.scale - 1) > 0.001 ||
        Math.abs(transform.positionX) > 0.001 ||
        Math.abs(transform.positionY) > 0.001 ||
        Math.abs(transform.rotation) > 0.001 ||
        Math.abs(transform.opacity - 1) > 0.001)) ||
    effects.some((effect) => effect.enabled && effect.amount > 0)
  );
}

function buildCssFilter(colorValue: TimelineClip["color"], lut: TimelineClip["lut"], effects: ClipEffect[]) {
  const color = normalizeColor(colorValue);
  const filters = [
    `brightness(${Math.max(0, 1 + color.brightness / 100)})`,
    `contrast(${Math.max(0, 1 + color.contrast / 100)})`,
    `saturate(${Math.max(0, color.saturation)})`
  ];

  if (color.temperature || color.tint) {
    filters.push(`hue-rotate(${(color.tint + color.temperature * 0.35).toFixed(1)}deg)`);
  }

  if (lut?.lutId && lut.strength > 0) {
    filters.push(cssLutFilter(lut.lutId, lut.strength));
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

function cssLutFilter(lutId: string, strength: number) {
  const amount = Math.max(0, Math.min(1, strength));
  if (lutId === "warm") {
    return `sepia(${0.18 * amount}) saturate(${1 + 0.18 * amount})`;
  }
  if (lutId === "cool") {
    return `hue-rotate(${-10 * amount}deg) saturate(${1 + 0.08 * amount})`;
  }
  if (lutId === "filmic") {
    return `contrast(${1 + 0.22 * amount}) saturate(${1 - 0.12 * amount})`;
  }
  if (lutId === "mono") {
    return `grayscale(${0.9 * amount}) contrast(${1 + 0.12 * amount})`;
  }
  return "";
}

function normalizeColor(value?: Partial<ColorAdjustment>): ColorAdjustment {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 1,
    temperature: 0,
    tint: 0,
    ...value
  };
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

function formatMediaAssetDetail(asset: MediaAsset) {
  if (!asset.metadata || asset.kind === "audio") {
    const duration = asset.metadata?.durationUs ? ` - ${formatDuration(asset.metadata.durationUs)}` : "";
    return `${asset.kind.toUpperCase()} - ${asset.extension}${duration}`;
  }

  const fps = asset.metadata.fps > 0 ? `${Math.round(asset.metadata.fps)} fps` : "fps unknown";
  const resolution = asset.metadata.width > 0 && asset.metadata.height > 0 ? `${asset.metadata.width}x${asset.metadata.height}` : "resolution unknown";
  return `${resolution} - ${fps} - ${formatDuration(asset.metadata.durationUs)} - ${asset.metadata.hdr ? "HDR" : "SDR"}`;
}

function formatDuration(durationUs = 0) {
  if (!durationUs || durationUs <= 0) {
    return "duration unknown";
  }
  const totalSeconds = Math.round(durationUs / 1_000_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}:${seconds.toString().padStart(2, "0")}` : `0:${seconds.toString().padStart(2, "0")}`;
}

function statusLabel(label: string, status: MediaCacheStatus["thumbnail"]) {
  if (status === "ready-on-demand") {
    return `${label}: demand`;
  }
  if (status === "not-applicable") {
    return `${label}: n/a`;
  }
  if (status === "not-needed") {
    return `${label}: none`;
  }
  return `${label}: ${status}`;
}

function filterAndSortMediaAssets(
  assets: MediaAsset[],
  options: {
    search: string;
    type: MediaTypeFilter;
    duration: MediaDurationFilter;
    resolution: MediaResolutionFilter;
    fps: MediaFpsFilter;
    sort: MediaSortKey;
    missingPaths: Set<string>;
  }
) {
  const query = options.search.trim().toLowerCase();
  const filtered = assets.filter((asset) => {
    if (query && !`${asset.name} ${asset.path} ${asset.extension} ${asset.metadata?.codec ?? ""}`.toLowerCase().includes(query)) {
      return false;
    }

    if (options.type === "missing") {
      if (!options.missingPaths.has(asset.path)) {
        return false;
      }
    } else if (options.type !== "all" && asset.kind !== options.type) {
      return false;
    }

    if (!matchesDurationFilter(asset, options.duration)) {
      return false;
    }
    if (!matchesResolutionFilter(asset, options.resolution)) {
      return false;
    }
    return matchesFpsFilter(asset, options.fps);
  });

  return filtered.sort((left, right) => compareMediaAssets(left, right, options.sort));
}

function matchesDurationFilter(asset: MediaAsset, filter: MediaDurationFilter) {
  if (filter === "all") {
    return true;
  }
  const seconds = (asset.metadata?.durationUs ?? 0) / 1_000_000;
  if (filter === "short") {
    return seconds > 0 && seconds < 60;
  }
  if (filter === "medium") {
    return seconds >= 60 && seconds <= 600;
  }
  return seconds > 600;
}

function matchesResolutionFilter(asset: MediaAsset, filter: MediaResolutionFilter) {
  if (filter === "all") {
    return true;
  }
  const width = asset.metadata?.width ?? 0;
  const height = asset.metadata?.height ?? 0;
  if (filter === "unknown") {
    return width <= 0 || height <= 0;
  }
  if (filter === "uhd") {
    return width >= 3840 || height >= 2160;
  }
  return width > 0 && height > 0 && width < 3840 && height < 2160;
}

function matchesFpsFilter(asset: MediaAsset, filter: MediaFpsFilter) {
  if (filter === "all") {
    return true;
  }
  const fps = asset.metadata?.fps ?? 0;
  if (filter === "unknown") {
    return fps <= 0;
  }
  if (filter === "24") {
    return fps > 0 && fps < 29;
  }
  if (filter === "30") {
    return fps >= 29 && fps < 49;
  }
  return fps >= 49;
}

function compareMediaAssets(left: MediaAsset, right: MediaAsset, sort: MediaSortKey) {
  if (sort === "name-asc") {
    return left.name.localeCompare(right.name);
  }
  if (sort === "name-desc") {
    return right.name.localeCompare(left.name);
  }
  if (sort === "duration-desc") {
    return (right.metadata?.durationUs ?? 0) - (left.metadata?.durationUs ?? 0);
  }
  if (sort === "resolution-desc") {
    return (right.metadata?.width ?? 0) * (right.metadata?.height ?? 0) - (left.metadata?.width ?? 0) * (left.metadata?.height ?? 0);
  }
  if (sort === "fps-desc") {
    return (right.metadata?.fps ?? 0) - (left.metadata?.fps ?? 0);
  }
  if (sort === "type") {
    return left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name);
  }
  return Date.parse(right.importedAt) - Date.parse(left.importedAt);
}

function compareClipsByTimeline(left: TimelineClip, right: TimelineClip) {
  return left.trackId.localeCompare(right.trackId) || left.startUs - right.startUs || left.id.localeCompare(right.id);
}

function getTimelineContentEndUs(timeline: Timeline) {
  return timeline.tracks.reduce(
    (duration, track) =>
      Math.max(
        duration,
        ...track.clips.map((clip) => clip.startUs + Math.max(0, clip.outUs - clip.inUs))
      ),
    0
  );
}

function getTimelineEditDurationUs(timeline: Timeline) {
  return Math.max(minTimelineDurationUs, getTimelineContentEndUs(timeline) + timelineTailRoomUs);
}

function withTimelineEditDuration(timeline: Timeline): Timeline {
  return {
    ...timeline,
    durationUs: getTimelineEditDurationUs(timeline)
  };
}

function rippleDeleteClips(timeline: Timeline, deletedClips: TimelineClip[]) {
  const deletedByTrack = new Map<string, TimelineClip[]>();
  for (const clip of deletedClips) {
    deletedByTrack.set(clip.trackId, [...(deletedByTrack.get(clip.trackId) ?? []), clip]);
  }
  const deletedIds = new Set(deletedClips.map((clip) => clip.id));

  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => {
      const trackDeletedClips = (deletedByTrack.get(track.id) ?? []).sort((left, right) => left.startUs - right.startUs);
      if (trackDeletedClips.length === 0) {
        return track;
      }

      return {
        ...track,
        clips: track.clips
          .filter((clip) => !deletedIds.has(clip.id))
          .map((clip) => {
            const offsetUs = trackDeletedClips
              .filter((deletedClip) => deletedClip.startUs < clip.startUs)
              .reduce((offset, deletedClip) => offset + (deletedClip.outUs - deletedClip.inUs), 0);
            return offsetUs > 0 ? { ...clip, startUs: Math.max(0, clip.startUs - offsetUs) } : clip;
          })
      };
    })
  };
}

function findActiveClip(timeline: typeof starterTimeline, playheadUs: number, kind: "video" | "audio", soloTrackIds: string[] = []) {
  return timeline.tracks
    .filter((track) => track.kind === kind && !track.locked && (kind === "audio" ? !track.muted : track.visible) && (soloTrackIds.length === 0 || soloTrackIds.includes(track.id)))
    .flatMap((track) => track.clips)
    .find((clip) => playheadUs >= clip.startUs && playheadUs < clip.startUs + (clip.outUs - clip.inUs));
}

function getClipMediaTimeUs(clip: TimelineClip, playheadUs: number) {
  return clamp(playheadUs - clip.startUs + clip.inUs, clip.inUs, Math.max(clip.inUs, clip.outUs - 1));
}

function isPlayheadInsideClip(clip: TimelineClip, playheadUs: number) {
  return playheadUs > clip.startUs && playheadUs < clip.startUs + (clip.outUs - clip.inUs);
}

function quantizePreviewFrameTime(timeUs: number) {
  return Math.max(0, Math.round(timeUs / 500_000) * 500_000);
}

function syncMediaElement<T extends HTMLVideoElement | HTMLAudioElement>(
  ref: RefObject<T>,
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

function applyMediaElementAudio<T extends HTMLVideoElement | HTMLAudioElement>(
  ref: RefObject<T>,
  graphRef: MutableRefObject<MediaAudioGraph | null>,
  clip: TimelineClip | undefined,
  projectSettings: ProjectSettings,
  playheadUs: number,
  playing: boolean
) {
  const element = ref.current;
  if (!element) {
    return;
  }

  if (!clip || !projectSettings.audioEnabled) {
    setMediaElementGain(element, graphRef, 0, playing);
    return;
  }

  const audio = normalizeAudioAdjustment(clip.audio);
  const clipTimeUs = clamp(playheadUs - clip.startUs, 0, clip.outUs - clip.inUs);
  const fadeMultiplier = audioFadeMultiplier(audio, clipTimeUs, clip.outUs - clip.inUs);
  const linearGain = dbToLinear((projectSettings.masterGainDb ?? 0) + audio.gainDb) * fadeMultiplier;
  setMediaElementGain(element, graphRef, audio.muted ? 0 : linearGain, playing);
}

function setMediaElementGain(
  element: HTMLMediaElement,
  graphRef: MutableRefObject<MediaAudioGraph | null>,
  linearGain: number,
  playing: boolean
) {
  const gain = clamp(linearGain, 0, 4);
  const graph = ensureMediaAudioGraph(element, graphRef);
  if (graph) {
    graph.gain.gain.value = gain;
    element.muted = false;
    element.volume = 1;
    if (playing && graph.context.state === "suspended") {
      void graph.context.resume().catch(() => undefined);
    }
    return;
  }

  element.muted = gain <= 0.001;
  element.volume = clamp(gain, 0, 1);
}

function ensureMediaAudioGraph(
  element: HTMLMediaElement,
  graphRef: MutableRefObject<MediaAudioGraph | null>
): MediaAudioGraph | null {
  if (graphRef.current?.element === element) {
    return graphRef.current;
  }

  try {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    const context = new AudioContextCtor();
    const source = context.createMediaElementSource(element);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    graphRef.current = { element, context, source, gain };
    return graphRef.current;
  } catch {
    return null;
  }
}

function normalizeAudioAdjustment(value?: Partial<AudioAdjustment>): AudioAdjustment {
  return {
    ...defaultAudioAdjustment,
    ...value
  };
}

function audioFadeMultiplier(audio: AudioAdjustment, clipTimeUs: number, durationUs: number) {
  let multiplier = 1;
  if (audio.fadeInUs > 0 && clipTimeUs < audio.fadeInUs) {
    multiplier *= clamp(clipTimeUs / audio.fadeInUs, 0, 1);
  }
  if (audio.fadeOutUs > 0) {
    const fadeOutStartUs = Math.max(0, durationUs - audio.fadeOutUs);
    if (clipTimeUs > fadeOutStartUs) {
      multiplier *= clamp((durationUs - clipTimeUs) / audio.fadeOutUs, 0, 1);
    }
  }
  return multiplier;
}

function dbToLinear(gainDb: number) {
  return Math.pow(10, gainDb / 20);
}

function getTimelineDurationSeconds(durationUs: number) {
  return Math.max(Math.ceil(minTimelineDurationUs / 1_000_000), Math.ceil(durationUs / 1_000_000));
}

function getFallbackMediaDurationUs(asset: MediaAsset) {
  if (asset.metadata?.durationUs && asset.metadata.durationUs > 0) {
    return asset.metadata.durationUs;
  }
  return asset.kind === "audio" ? defaultAudioDurationUs : defaultVideoDurationUs;
}

function getTrackEndUs(track: (typeof starterTimeline.tracks)[number], excludedClipId = "") {
  return track.clips
    .filter((clip) => clip.id !== excludedClipId)
    .reduce((endUs, clip) => Math.max(endUs, clip.startUs + (clip.outUs - clip.inUs)), 0);
}

function getClipVisualLeft(startUs: number, zoomPxPerSecond: number) {
  return (startUs / 1_000_000) * zoomPxPerSecond + visualClipGapPx / 2;
}

function getClipVisualWidth(durationUs: number, zoomPxPerSecond: number) {
  const rawWidth = Math.max((durationUs / 1_000_000) * zoomPxPerSecond, 8);
  return Math.max(rawWidth - visualClipGapPx, 8);
}

function resolveMediaDropPlacement(
  timeline: typeof starterTimeline,
  asset: MediaAsset,
  trackId: string,
  rawStartUs: number,
  zoomPxPerSecond: number,
  snappingEnabled: boolean
): MediaDropPreviewState {
  const targetTrack = timeline.tracks.find((track) => track.id === trackId);
  const invalid = !targetTrack || targetTrack.locked || !canMediaAssetUseTrack(asset, targetTrack.kind);
  const durationUs = getFallbackMediaDurationUs(asset);
  if (!targetTrack || invalid) {
    return {
      trackId,
      startUs: Math.max(0, rawStartUs),
      durationUs,
      snapped: false,
      invalid
    };
  }

  const resolved = snappingEnabled
    ? resolveTrackSnapStart(timeline, trackId, rawStartUs, zoomPxPerSecond, "", true)
    : { startUs: Math.max(0, rawStartUs), snapped: false };

  return {
    trackId,
    startUs: resolved.startUs,
    durationUs,
    snapped: resolved.snapped,
    invalid: false
  };
}

function canMediaAssetUseTrack(asset: MediaAsset, trackKind: "video" | "audio") {
  return asset.kind === trackKind || (trackKind === "audio" && Boolean(asset.metadata?.hasAudio));
}

function resolveTrackSnapStart(
  timeline: typeof starterTimeline,
  trackId: string,
  rawStartUs: number,
  zoomPxPerSecond: number,
  excludedClipId: string,
  preferTrackEnd: boolean
) {
  const targetTrack = timeline.tracks.find((track) => track.id === trackId);
  const startUs = Math.max(0, rawStartUs);
  if (!targetTrack) {
    return { startUs, snapped: false };
  }

  const snapThresholdUs = Math.round((snapThresholdPx / zoomPxPerSecond) * 1_000_000);
  const candidates = targetTrack.clips
    .filter((clip) => clip.id !== excludedClipId)
    .flatMap((clip) => [clip.startUs, clip.startUs + (clip.outUs - clip.inUs)]);

  if (candidates.length === 0) {
    const gridStartUs = snapTime(startUs);
    return { startUs: gridStartUs, snapped: gridStartUs !== startUs };
  }

  const nearest = candidates.reduce(
    (best, candidate) => {
      const distance = Math.abs(candidate - startUs);
      return distance < best.distance ? { startUs: candidate, distance } : best;
    },
    { startUs, distance: Number.POSITIVE_INFINITY }
  );

  if (nearest.distance <= snapThresholdUs) {
    return { startUs: Math.max(0, nearest.startUs), snapped: true };
  }

  if (preferTrackEnd) {
    return { startUs: getTrackEndUs(targetTrack, excludedClipId), snapped: true };
  }

  const gridStartUs = snapTime(startUs);
  return { startUs: gridStartUs, snapped: gridStartUs !== startUs };
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
