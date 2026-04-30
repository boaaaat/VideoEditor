#pragma once

#include "color/ColorSettings.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace ai_editor {

struct ClipTransform {
  bool enabled = true;
  double scale = 1.0;
  double positionX = 0.0;
  double positionY = 0.0;
  double rotation = 0.0;
  double opacity = 1.0;
};

struct ClipEffect {
  std::string id;
  std::string type;
  std::string label;
  bool enabled = false;
  double amount = 0.0;
};

struct Clip {
  std::string id;
  std::string mediaId;
  std::string trackId;
  std::int64_t startUs = 0;
  std::int64_t inUs = 0;
  std::int64_t outUs = 0;
  ColorSettings color;
  double audioGainDb = 0.0;
  bool audioMuted = false;
  std::int64_t audioFadeInUs = 0;
  std::int64_t audioFadeOutUs = 0;
  bool audioNormalize = false;
  bool audioCleanup = false;
  ClipTransform transform;
  std::vector<ClipEffect> effects;
  double speedPercent = 100.0;
};

}  // namespace ai_editor
