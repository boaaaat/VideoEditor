#pragma once

#include "timeline/Clip.hpp"

#include <string>
#include <vector>

namespace ai_editor {

enum class TrackKind {
  Video,
  Audio,
};

struct Track {
  std::string id;
  std::string name;
  TrackKind kind = TrackKind::Video;
  int index = 0;
  bool locked = false;
  bool muted = false;
  bool visible = true;
  std::vector<Clip> clips;
};

}  // namespace ai_editor
