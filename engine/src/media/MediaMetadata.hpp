#pragma once

#include <cstdint>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace ai_editor {

struct MediaAudioStream {
  int index = 0;
  std::string codec = "unknown";
  int channels = 0;
  std::string title;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"index", index},
        {"codec", codec},
        {"channels", channels},
        {"title", title},
    };
  }
};

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
  std::vector<MediaAudioStream> audioStreams;

  [[nodiscard]] nlohmann::json toJson() const {
    auto audioRows = nlohmann::json::array();
    for (const auto& stream : audioStreams) {
      audioRows.push_back(stream.toJson());
    }
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
        {"audioStreamCount", audioStreams.size()},
        {"audioStreams", audioRows},
    };
  }
};

}  // namespace ai_editor
