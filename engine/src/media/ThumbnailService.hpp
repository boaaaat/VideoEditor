#pragma once

#include <filesystem>

namespace ai_editor {

class ThumbnailService {
 public:
  [[nodiscard]] std::filesystem::path thumbnailPathFor(const std::filesystem::path& mediaPath) const {
    return mediaPath.filename().replace_extension(".jpg");
  }
};

}  // namespace ai_editor
