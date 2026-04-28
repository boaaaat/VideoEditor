import type { Timeline } from "@ai-video-editor/protocol";

export const starterTimeline: Timeline = {
  id: "timeline_main",
  name: "Main Timeline",
  fps: 30,
  durationUs: 60_000_000,
  tracks: [
    {
      id: "v2",
      name: "Video 2",
      kind: "video",
      index: 0,
      locked: false,
      muted: false,
      visible: true,
      clips: []
    },
    {
      id: "v1",
      name: "Video 1",
      kind: "video",
      index: 1,
      locked: false,
      muted: false,
      visible: true,
      clips: []
    },
    {
      id: "a1",
      name: "Audio 1",
      kind: "audio",
      index: 2,
      locked: false,
      muted: false,
      visible: true,
      clips: []
    }
  ]
};
