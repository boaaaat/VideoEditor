#pragma once

#include <string>

namespace ai_editor {

struct ExportJob {
  std::string id;
  std::string outputPath;
  std::string resolution = "1080p";
  int fps = 30;
  std::string codec = "h264_nvenc";
  int bitrateMbps = 20;
  bool cancelled = false;
};

}  // namespace ai_editor
