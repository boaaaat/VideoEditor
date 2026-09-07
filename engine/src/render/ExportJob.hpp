#pragma once

#include <nlohmann/json.hpp>
#include "timeline/TitleOverlay.hpp"

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
  bool isStillImage = false;
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
  int audioStreamIndex = 0;
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
  std::int64_t videoFadeInUs = 0;
  std::int64_t videoFadeOutUs = 0;
  std::vector<ExportClipEffect> effects;
  double speedPercent = 100.0;
  std::int64_t audioFadeOffsetUs = 0;
  std::int64_t audioFadeDurationUs = 0;
  std::int64_t videoFadeOffsetUs = 0;
  std::int64_t videoFadeDurationUs = 0;
};

struct ExportTimelineSegment {
  const ExportTimelineClip* clip = nullptr;
  std::int64_t startUs = 0;
  std::int64_t sourceInUs = 0;
  std::int64_t sourceDurationUs = 0;
  std::int64_t durationUs = 0;
  bool gap = false;
};

struct ExportRequestTimeline {
  std::vector<TitleOverlay> titles;
  std::vector<ExportMediaAsset> media;
  std::vector<ExportTimelineClip> clips;
};

struct ExportEncoderOptions {
  bool enabled = false;
  std::string preset = "p5";
  std::string tune = "hq";
  int cq = 20;
  int maxBitrateMbps = 32;
  int lookaheadDepth = 16;
  int lookaheadLevel = 0;
  std::string multipass = "qres";
  bool spatialAq = true;
  bool temporalAq = true;
  int aqStrength = 8;
  int bFrames = 3;
  std::string bRefMode = "middle";
  int referenceFrames = 4;
  bool highBitDepth = true;
  std::string splitEncodeMode = "disabled";

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"enabled", enabled},
        {"preset", preset},
        {"tune", tune},
        {"cq", cq},
        {"maxBitrateMbps", maxBitrateMbps},
        {"lookaheadDepth", lookaheadDepth},
        {"lookaheadLevel", lookaheadLevel},
        {"multipass", multipass},
        {"spatialAq", spatialAq},
        {"temporalAq", temporalAq},
        {"aqStrength", aqStrength},
        {"bFrames", bFrames},
        {"bRefMode", bRefMode},
        {"referenceFrames", referenceFrames},
        {"highBitDepth", highBitDepth},
        {"splitEncodeMode", splitEncodeMode},
    };
  }
};

struct ExportRequest {
  std::int64_t rangeStartUs = 0;
  std::string outputPath;
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::int64_t durationUs = 10'000'000;
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
  ExportEncoderOptions encoderOptions;
  ExportRequestTimeline timeline;
};

struct ExportJob {
  std::string resourceDirectory;
  std::int64_t rangeStartUs = 0;
  std::string id;
  std::string outputPath;
  std::string state = "running";
  double progress = 0.0;
  double encodingFps = 0.0;
  double speed = 0.0;
  double elapsedSeconds = 0.0;
  double etaSeconds = 0.0;
  std::int64_t processedFrames = 0;
  std::chrono::steady_clock::time_point startedAt = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point finishedAt = {};
  std::string resolution = "1080p";
  int width = 1920;
  int height = 1080;
  int fps = 30;
  std::int64_t durationUs = 10'000'000;
  std::string codec = "h264_nvenc";
  std::string container = "mp4";
  std::string quality = "medium";
  int bitrateMbps = 20;
  bool audioEnabled = true;
  std::string colorMode = "SDR";
  double masterGainDb = 0.0;
  bool normalizeAudio = false;
  bool cleanupAudio = false;
  ExportEncoderOptions encoderOptions;
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
        {"encodingFps", encodingFps},
        {"speed", speed},
        {"elapsedSeconds", elapsedSeconds},
        {"etaSeconds", etaSeconds},
        {"processedFrames", processedFrames},
        {"resolution", resolution},
        {"width", width},
        {"height", height},
        {"fps", fps},
        {"durationUs", durationUs},
        {"rangeStartUs", rangeStartUs},
        {"rangeEndUs", rangeStartUs + durationUs},
        {"codec", codec},
        {"container", container},
        {"quality", quality},
        {"bitrateMbps", bitrateMbps},
        {"audioEnabled", audioEnabled},
        {"colorMode", colorMode},
        {"masterGainDb", masterGainDb},
        {"normalizeAudio", normalizeAudio},
        {"cleanupAudio", cleanupAudio},
        {"encoderOptions", encoderOptions.toJson()},
        {"ffmpegCommand", ffmpegCommand},
        {"logs", logs},
        {"cancelled", cancelled},
    };
  }
};

}  // namespace ai_editor
