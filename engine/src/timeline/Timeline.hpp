#pragma once

#include "timeline/Track.hpp"
#include "timeline/TitleOverlay.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace ai_editor {

struct TimelineMarker {
  std::string id;
  std::int64_t timeUs = 0;
  std::string name = "Marker";
  std::string color = "#f5c76b";
};

struct Timeline {
  std::string id = "timeline_main";
  std::string name = "Main Timeline";
  double fps = 30.0;
  std::int64_t durationUs = 0;
  std::vector<Track> tracks;
  std::vector<TimelineMarker> markers;
  std::vector<TitleOverlay> titles;
};

}  // namespace ai_editor
