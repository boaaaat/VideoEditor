#pragma once

#include <string>

namespace ai_editor {

enum class PreviewQuality {
  Full,
  Half,
  Quarter,
  Proxy,
};

class PlaybackEngine {
 public:
  void setQuality(PreviewQuality quality) { quality_ = quality; }
  [[nodiscard]] PreviewQuality quality() const { return quality_; }
  [[nodiscard]] std::string state() const { return playing_ ? "playing" : "paused"; }
  void play() { playing_ = true; }
  void pause() { playing_ = false; }

 private:
  PreviewQuality quality_ = PreviewQuality::Proxy;
  bool playing_ = false;
};

}  // namespace ai_editor
