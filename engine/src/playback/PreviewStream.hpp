#pragma once

#include <cstdint>

namespace ai_editor {

struct PreviewFrameStats {
  std::int64_t frameNumber = 0;
  int droppedFrames = 0;
};

class PreviewStream {
 public:
  [[nodiscard]] PreviewFrameStats stats() const { return stats_; }

 private:
  PreviewFrameStats stats_;
};

}  // namespace ai_editor
