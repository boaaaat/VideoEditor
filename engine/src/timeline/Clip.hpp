#pragma once

#include "color/ColorSettings.hpp"

#include <cstdint>
#include <string>

namespace ai_editor {

struct Clip {
  std::string id;
  std::string mediaId;
  std::string trackId;
  std::int64_t startUs = 0;
  std::int64_t inUs = 0;
  std::int64_t outUs = 0;
  ColorSettings color;
};

}  // namespace ai_editor
