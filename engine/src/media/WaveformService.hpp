#pragma once

#include <filesystem>

namespace ai_editor {

class WaveformService {
 public:
  [[nodiscard]] std::filesystem::path waveformPathFor(const std::filesystem::path& mediaPath) const {
    return mediaPath.filename().replace_extension(".waveform.json");
  }
};

}  // namespace ai_editor
