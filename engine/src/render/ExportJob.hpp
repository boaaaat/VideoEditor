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

struct ExportMediaAsset {
  std::string id;
  std::string path;
  std::string kind = "video";
  bool hasAudio = false;
};

struct ExportClipEffect {
  std::string id;
  std::string type;
  std::string label;
  bool enabled = false;
  double amount = 0.0;
};

struct ExportTimelineClip {
  std::string mediaId;
  std::string trackId;
  std::string trackKind = "video";
  int trackIndex = 0;
  bool trackVisible = true;
  bool trackMuted = false;
  std::int64_t startUs = 0;
  std::int64_t inUs = 0;
  std::int64_t outUs = 0;
  double audioGainDb = 0.0;
  bool audioMuted = false;
  std::int64_t audioFadeInUs = 0;
  std::int64_t audioFadeOutUs = 0;
  bool audioNormalize = false;
  bool audioCleanup = false;
  double brightness = 0.0;
  double contrast = 0.0;
  double saturation = 1.0;
  double temperature = 0.0;
  double tint = 0.0;
  std::string lutId;
  double lutStrength = 1.0;
  bool transformEnabled = true;
  double scale = 1.0;
  double positionX = 0.0;
  double positionY = 0.0;
  double rotation = 0.0;
  double opacity = 1.0;
  std::vector<ExportClipEffect> effects;
};

struct ExportTimelineSegment {
  const ExportTimelineClip* clip = nullptr;
  std::int64_t startUs = 0;
  std::int64_t sourceInUs = 0;
  std::int64_t durationUs = 0;
  bool gap = false;
};

struct ExportRequestTimeline {
  std::vector<ExportMediaAsset> media;
  std::vector<ExportTimelineClip> clips;
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
  double masterGainDb = 0.0;
  bool normalizeAudio = false;
  bool cleanupAudio = false;
  ExportRequestTimeline timeline;
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
  double masterGainDb = 0.0;
  bool normalizeAudio = false;
  bool cleanupAudio = false;
  std::string ffmpegCommand;
  std::vector<std::string> logs;
  bool cancelled = false;
  ExportRequestTimeline timeline;

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
        {"masterGainDb", masterGainDb},
        {"normalizeAudio", normalizeAudio},
        {"cleanupAudio", cleanupAudio},
        {"ffmpegCommand", ffmpegCommand},
        {"logs", logs},
        {"cancelled", cancelled},
    };
  }
};

}  // namespace ai_editor
