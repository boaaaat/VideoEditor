#pragma once

#include <filesystem>

namespace ai_editor {

class ProxyService {
 public:
  [[nodiscard]] std::filesystem::path proxyPathFor(const std::filesystem::path& mediaPath) const {
    return mediaPath.filename().replace_extension(".proxy.mp4");
  }
};

}  // namespace ai_editor
