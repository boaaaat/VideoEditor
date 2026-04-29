#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

namespace ai_editor {

struct ExportProgressEvent {
  std::string status;
  std::int64_t outTimeUs = 0;
  double progress = 0.0;
};

struct ExportRequest {
  std::string outputPath;
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::int64_t durationUs = 60'000'000;
  std::string codec = "h264_nvenc";
  std::string container = "mp4";
  std::string quality = "medium";
  int bitrateMbps = 20;
  bool audioEnabled = true;
  std::string colorMode = "SDR";
  bool overwrite = false;
};

struct ExportJob {
  std::string id;
  std::string outputPath;
  std::string state = "running";
  double progress = 0.0;
  std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point finishedAt = {};
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::int64_t durationUs = 60'000'000;
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
        {"durationUs", durationUs},
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
