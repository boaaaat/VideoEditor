#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace ai_editor {

struct ExportRequest {
  std::string outputPath;
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::string codec = "h264_nvenc";
  std::string container = "mp4";
  std::string quality = "medium";
  int bitrateMbps = 20;
  bool audioEnabled = true;
  std::string colorMode = "SDR";
};

struct ExportJob {
  std::string id;
  std::string outputPath;
  std::string state = "running";
  double progress = 0.0;
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::string codec = "h264_nvenc";
  std::string container = "mp4";
  std::string quality = "medium";
  int bitrateMbps = 20;
  bool audioEnabled = true;
  std::string colorMode = "SDR";
  std::string ffmpegCommand;
  std::vector<std::string> logs;
  bool cancelled = false;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"jobId", id},
        {"outputPath", outputPath},
        {"state", state},
        {"progress", progress},
        {"resolution", resolution},
        {"width", width},
        {"height", height},
        {"fps", fps},
        {"codec", codec},
        {"container", container},
        {"quality", quality},
        {"bitrateMbps", bitrateMbps},
        {"audioEnabled", audioEnabled},
        {"colorMode", colorMode},
        {"ffmpegCommand", ffmpegCommand},
        {"logs", logs},
        {"cancelled", cancelled},
    };
  }
};

}  // namespace ai_editor
