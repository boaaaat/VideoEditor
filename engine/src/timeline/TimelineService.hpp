#pragma once

#include "timeline/Timeline.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace ai_editor {

class TimelineService {
 public:
  static void rippleDelete(Timeline& timeline, const std::string& clipId, bool allTracks = false) {
    for (auto& track : timeline.tracks) {
      const auto clipIt = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& clip) {
        return clip.id == clipId;
      });

      if (clipIt == track.clips.end()) {
        continue;
      }

      const auto deletedStart = clipIt->startUs;
      const auto sourceDuration = std::max<std::int64_t>(0, clipIt->outUs - clipIt->inUs);
      const auto speedPercent = std::isfinite(clipIt->speedPercent) ? std::clamp(clipIt->speedPercent, 25.0, 400.0) : 100.0;
      const auto deletedDuration = static_cast<std::int64_t>(std::llround(static_cast<double>(sourceDuration) / (speedPercent / 100.0)));
      if (track.locked) throw std::runtime_error("cannot ripple delete on a locked track");
      const auto deletedEnd = deletedStart + deletedDuration;
      if (allTracks) {
        for (const auto& affectedTrack : timeline.tracks) {
          if (affectedTrack.locked && std::any_of(affectedTrack.clips.begin(), affectedTrack.clips.end(), [&](const Clip& clip) { return clip.startUs >= deletedEnd; })) {
            throw std::runtime_error("ripple delete would move clips on a locked track");
          }
        }
      }
      track.clips.erase(clipIt);

      for (auto& affectedTrack : timeline.tracks) {
        if (!allTracks && affectedTrack.id != track.id) continue;
        for (auto& clip : affectedTrack.clips) {
          if (clip.startUs >= deletedEnd) {
            clip.startUs = std::max<std::int64_t>(0, clip.startUs - deletedDuration);
          }
        }
      }

      return;
    }

    throw std::runtime_error("clip not found for ripple delete");
  }
};

}  // namespace ai_editor
