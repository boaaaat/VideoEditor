#pragma once

#include "timeline/Track.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace ai_editor {

struct Timeline {
  std::string id = "timeline_main";
  std::string name = "Main Timeline";
  double fps = 30.0;
  std::int64_t durationUs = 0;
  std::vector<Track> tracks;
};

}  // namespace ai_editor
