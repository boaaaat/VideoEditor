#pragma once

#include <string>

namespace ai_editor {

struct ColorSettings {
  double brightness = 0.0;
  double contrast = 0.0;
  double saturation = 1.0;
  double temperature = 0.0;
  double tint = 0.0;
  std::string lutPath;
  double lutStrength = 1.0;
};

}  // namespace ai_editor
