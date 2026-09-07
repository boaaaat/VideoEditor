import type { Timeline, TimelineClip } from "@ai-video-editor/protocol";

export function clipDisplayDurationUs(clip: TimelineClip) {
  const speed = Number.isFinite(clip.speedPercent) ? Math.min(400, Math.max(25, clip.speedPercent ?? 100)) : 100;
  return Math.max(0, Math.round((clip.outUs - clip.inUs) / (speed / 100)));
}

/** The ruler has spare editing room; playback ends at the last clip or title. */
export function timelineContentDurationUs(timeline: Timeline) {
  let endUs = 0;
  for (const track of timeline.tracks) for (const clip of track.clips) endUs = Math.max(endUs, clip.startUs + clipDisplayDurationUs(clip));
  for (const title of timeline.titles ?? []) endUs = Math.max(endUs, title.startUs + title.durationUs);
  return endUs;
}
