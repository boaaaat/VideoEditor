import type { Timeline } from "@ai-video-editor/protocol";

export const starterTimeline: Timeline = {
  id: "timeline_main",
  name: "Main Timeline",
  fps: 30,
  durationUs: 36_000_000,
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
      clips: [
        {
          id: "clip_intro",
          mediaId: "media_001",
          trackId: "v1",
          startUs: 1_000_000,
          inUs: 0,
          outUs: 8_000_000,
          color: {
            brightness: 0,
            contrast: 0,
            saturation: 1,
            temperature: 0,
            tint: 0
          }
        },
        {
          id: "clip_broll",
          mediaId: "media_002",
          trackId: "v1",
          startUs: 11_000_000,
          inUs: 0,
          outUs: 10_000_000,
          color: {
            brightness: 0,
            contrast: 0.1,
            saturation: 1.05,
            temperature: 0,
            tint: 0
          }
        }
      ]
    },
    {
      id: "a1",
      name: "Audio 1",
      kind: "audio",
      index: 2,
      locked: false,
      muted: false,
      visible: true,
      clips: [
        {
          id: "clip_audio",
          mediaId: "media_003",
          trackId: "a1",
          startUs: 1_000_000,
          inUs: 0,
          outUs: 20_000_000,
          color: {
            brightness: 0,
            contrast: 0,
            saturation: 1,
            temperature: 0,
            tint: 0
          }
        }
      ]
    }
  ]
};
