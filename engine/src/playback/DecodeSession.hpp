#pragma once

#include <string>
#include <utility>

namespace ai_editor {

class DecodeSession {
 public:
  explicit DecodeSession(std::string mediaId) : mediaId_(std::move(mediaId)) {}
  [[nodiscard]] const std::string& mediaId() const { return mediaId_; }

 private:
  std::string mediaId_;
};

}  // namespace ai_editor
