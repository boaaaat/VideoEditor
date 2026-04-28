#pragma once

#include "timeline/Timeline.hpp"

#include <algorithm>
#include <stdexcept>

namespace ai_editor {

class TimelineService {
 public:
  static void rippleDelete(Timeline& timeline, const std::string& clipId) {
    for (auto& track : timeline.tracks) {
      const auto clipIt = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& clip) {
        return clip.id == clipId;
      });

      if (clipIt == track.clips.end()) {
        continue;
      }

      const auto deletedStart = clipIt->startUs;
      const auto deletedDuration = clipIt->outUs - clipIt->inUs;
      track.clips.erase(clipIt);

      for (auto& clip : track.clips) {
        if (clip.startUs > deletedStart) {
          clip.startUs = std::max<std::int64_t>(0, clip.startUs - deletedDuration);
        }
      }

      return;
    }

    throw std::runtime_error("clip not found for ripple delete");
  }
};

}  // namespace ai_editor
