#pragma once

#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>

namespace ai_editor {

struct MediaMetadata {
  std::string path;
  int width = 0;
  int height = 0;
  double fps = 0.0;
  std::int64_t durationUs = 0;
  std::string codec = "unknown";
  std::string pixelFormat = "unknown";
  std::string colorTransfer = "unknown";
  bool hdr = false;
  bool hasAudio = false;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"path", path},
        {"width", width},
        {"height", height},
        {"fps", fps},
        {"durationUs", durationUs},
        {"codec", codec},
        {"pixelFormat", pixelFormat},
        {"colorTransfer", colorTransfer},
        {"hdr", hdr},
        {"hasAudio", hasAudio},
    };
  }
};

}  // namespace ai_editor
