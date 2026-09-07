import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { Pause, Play, StepBack, StepForward } from "lucide-react";
import type { ProjectSettings, Timeline, TimelineClip } from "@ai-video-editor/protocol";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { TimecodeInput } from "../../components/TimecodeInput";
import type { MediaAsset } from "../../features/media/mediaTypes";
import { usePlaybackClock } from "../../features/timeline/usePlaybackClock";
import { timelineContentDurationUs } from "../../features/timeline/timing";
import { CompositionPreview } from "./EditTab";

interface ColorEffectsPlaybackProps {
  timeline: Timeline; mediaAssets: MediaAsset[]; projectSettings: ProjectSettings; projectPath?: string;
  selectedClipId: string; onSelectedClipIdChange: (clipId: string) => void;
  playheadUs: number; setPlayheadUs: Dispatch<SetStateAction<number>>;
  playing: boolean; setPlaying: Dispatch<SetStateAction<boolean>>;
  previewVolumePercent: number; previewSpeedPercent: number;
}

export function ColorEffectsPlayback({ timeline, mediaAssets, projectSettings, projectPath, selectedClipId,
  onSelectedClipIdChange, playheadUs, setPlayheadUs, playing, setPlaying, previewVolumePercent, previewSpeedPercent
}: ColorEffectsPlaybackProps) {
  const videoTracks = useMemo(() => timeline.tracks.filter((track) => track.kind === "video").sort((a, b) => a.index - b.index), [timeline]);
  const videoClips = useMemo(() => videoTracks.flatMap((track) => track.clips), [videoTracks]);
  const selectedClip = videoClips.find((clip) => clip.id === selectedClipId) ?? videoClips[0];
  const selectedAsset = mediaAssets.find((asset) => asset.id === selectedClip?.mediaId);
  const videoItems = videoTracks.filter((track) => track.visible).flatMap((track) => [...track.clips].sort((a, b) => b.startUs - a.startUs))
    .filter((clip) => containsTime(clip, playheadUs)).flatMap((clip) => {
      const asset = mediaAssets.find((item) => item.id === clip.mediaId);
      return asset ? [{ clip, asset }] : [];
    });
  const audioItems = [...timeline.tracks].sort((a, b) => (a.kind === "audio" ? 0 : 1) - (b.kind === "audio" ? 0 : 1) || a.index - b.index)
    .filter((track) => !track.muted && (track.kind === "audio" || track.visible)).flatMap((track) => track.clips)
    .filter((clip) => !clip.audio?.muted && containsTime(clip, playheadUs)).flatMap((clip) => {
      const asset = mediaAssets.find((item) => item.id === clip.mediaId);
      return asset && (asset.kind === "audio" || asset.metadata?.hasAudio) ? [{ clip, asset }] : [];
    });
  const durationUs = Math.max(1, timelineContentDurationUs(timeline));
  const videoMaster = videoItems.find((item) => !item.asset.metadata?.isStillImage);
  const clock = usePlaybackClock({ playing, playheadUs, clipId: audioItems[0]?.clip.id ?? videoMaster?.clip.id ?? "",
    durationUs, speedPercent: previewSpeedPercent, setPlaying, setPlayheadUs });

  useEffect(() => {
    if (selectedClip && containsTime(selectedClip, playheadUs)) return;
    const activeClip = videoClips.find((clip) => containsTime(clip, playheadUs));
    if (activeClip && activeClip.id !== selectedClipId) onSelectedClipIdChange(activeClip.id);
  }, [onSelectedClipIdChange, playheadUs, selectedClip, selectedClipId, videoClips]);

  function seek(timeUs: number) { setPlaying(false); setPlayheadUs(Math.max(0, Math.min(durationUs, timeUs))); }
  function togglePlayback() {
    if (!playing && playheadUs >= durationUs) setPlayheadUs(0);
    setPlaying((current) => !current);
  }

  return <div className="editor-playback-surface">
    <div className="editor-playback-preview">
      <CompositionPreview projectSettings={projectSettings} projectPath={projectPath} videoClip={videoMaster?.clip}
        timeline={timeline} mediaAssets={mediaAssets}
        videoItems={videoItems} audioItems={audioItems} titles={(timeline.titles ?? []).filter((title) => playheadUs >= title.startUs && playheadUs < title.startUs + title.durationUs)}
        playheadUs={playheadUs} playing={playing} previewQuality="Proxy" previewScale="fit"
        previewVolumePercent={previewVolumePercent} previewSpeedPercent={previewSpeedPercent} {...clock} />
    </div>
    <div className="editor-playback-controls">
      <div className="transport">
        <IconButton label={playing ? "Pause" : "Play"} icon={playing ? <Pause size={17} /> : <Play size={17} />} onClick={togglePlayback} disabled={timeline.durationUs <= 0} />
        <IconButton label="Step back one frame" icon={<StepBack size={16} />} onClick={() => seek(playheadUs - 1_000_000 / projectSettings.fps)} />
        <IconButton label="Step forward one frame" icon={<StepForward size={16} />} onClick={() => seek(playheadUs + 1_000_000 / projectSettings.fps)} />
        <TimecodeInput valueUs={playheadUs} fps={projectSettings.fps} maxUs={durationUs} onSeek={seek} />
      </div>
      <div className="editor-playback-meta">
        <span>{selectedAsset?.name ?? "No video selected"}</span>
        {selectedClip ? <Button onClick={() => seek(selectedClip.startUs)}>Jump to Clip</Button> : null}
      </div>
      <input type="range" aria-label="Preview timeline position" min={0} max={durationUs} step={Math.round(1_000_000 / projectSettings.fps)} value={playheadUs} onChange={(event) => seek(Number(event.target.value))} />
      <div className="editor-mini-timeline" aria-label="Video clips" style={{ minHeight: Math.max(96, videoTracks.length * 34 + 20) }}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); seek(durationUs * (event.clientX - rect.left) / Math.max(1, rect.width)); }}>
        {videoTracks.flatMap((track, row) => track.clips.map((clip) => {
          const asset = mediaAssets.find((item) => item.id === clip.mediaId);
          return <button type="button" key={clip.id} className={clip.id === selectedClip?.id ? "editor-mini-clip selected" : "editor-mini-clip"}
            aria-label={`${asset?.name ?? clip.id}, ${track.name}`} title={`${asset?.name ?? clip.id} · ${track.name}${track.locked ? " · Locked" : ""}`}
            style={{ left: `${clip.startUs / durationUs * 100}%`, width: `${Math.max(.5, clipDuration(clip) / durationUs * 100)}%`, top: 10 + row * 34, opacity: track.visible ? 1 : .4 }}
            onClick={(event) => { event.stopPropagation(); onSelectedClipIdChange(clip.id); seek(clip.startUs); }} />;
        }))}
        <span className="editor-mini-playhead" style={{ left: `${Math.min(1, playheadUs / durationUs) * 100}%` }} />
      </div>
    </div>
  </div>;
}

function clipDuration(clip: TimelineClip) { return Math.max(1, Math.round((clip.outUs - clip.inUs) / ((clip.speedPercent ?? 100) / 100))); }
function containsTime(clip: TimelineClip, timeUs: number) { return timeUs >= clip.startUs && timeUs < clip.startUs + clipDuration(clip); }
