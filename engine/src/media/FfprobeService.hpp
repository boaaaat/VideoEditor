#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace ai_editor {

class FfprobeService {
 public:
  [[nodiscard]] nlohmann::json probe(const std::string& path) const {
    return {
        {"path", path},
        {"status", "pending_ffprobe_integration"},
    };
  }
};

}  // namespace ai_editor
