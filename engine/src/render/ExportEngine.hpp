#pragma once

#include "render/ExportJob.hpp"
#include "platform/FfmpegLocator.hpp"
#include "platform/GpuDetector.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ai_editor {

class ExportEngine {
 public:
  ExportEngine(const FfmpegLocator& locator, const GpuDetector& gpuDetector)
      : locator_(locator), gpuDetector_(gpuDetector) {}

  [[nodiscard]] ExportJob createJob(const std::string& outputPath) const {
    ExportRequest request;
    request.outputPath = outputPath;
    return createJob(request);
  }

  [[nodiscard]] ExportJob createJob(const ExportRequest& request) const {
    ExportJob job;
    job.id = "export_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    job.outputPath = request.outputPath;
    job.resolution = request.resolution;
    job.width = request.width;
    job.height = request.height;
    job.fps = request.fps;
    job.codec = request.codec;
    job.container = request.container;
    job.quality = request.quality;
    job.bitrateMbps = request.bitrateMbps > 0 ? request.bitrateMbps : calculateBitrateMbps(request);
    job.audioEnabled = request.audioEnabled;
    job.colorMode = request.colorMode;
    job.ffmpegCommand = buildFfmpegCommand(job);
    return job;
  }

  nlohmann::json start(const nlohmann::json& params) {
    const auto request = requestFromJson(params);
    const auto gpu = gpuDetector_.detect();
    const auto errors = validate(request, gpu);
    if (!errors.empty()) {
      throw std::runtime_error(join(errors, "; "));
    }

    auto job = createJob(request);
    job.logs.push_back("Export queued");
    job.logs.push_back("FFmpeg command: " + job.ffmpegCommand);
    job.logs.push_back("Waiting for timeline render graph input");
    activeJob_ = job;
    return activeJob_->toJson();
  }

  nlohmann::json cancel() {
    if (!activeJob_) {
      return idleStatus();
    }

    activeJob_->cancelled = true;
    activeJob_->state = "cancelled";
    activeJob_->logs.push_back("Export cancelled");
    return activeJob_->toJson();
  }

  nlohmann::json status() {
    if (!activeJob_) {
      return idleStatus();
    }

    if (activeJob_->state == "running") {
      activeJob_->progress = std::min(1.0, activeJob_->progress + 0.08);
      activeJob_->logs.push_back("Progress " + std::to_string(static_cast<int>(activeJob_->progress * 100.0)) + "%");
      if (activeJob_->progress >= 1.0) {
        activeJob_->state = "completed";
        activeJob_->logs.push_back("Export completed");
      }
    }

    return activeJob_->toJson();
  }

  [[nodiscard]] static ExportRequest requestFromJson(const nlohmann::json& params) {
    ExportRequest request;
    request.outputPath = params.value("outputPath", std::string{});
    request.resolution = params.value("resolution", std::string{"1080p"});
    request.width = params.value("width", 1920);
    request.height = params.value("height", 1080);
    request.fps = params.value("fps", 30);
    request.codec = params.value("codec", std::string{"h264_nvenc"});
    request.container = params.value("container", std::string{"mp4"});
    request.quality = params.value("quality", std::string{"medium"});
    request.bitrateMbps = params.value("bitrateMbps", 0);
    request.audioEnabled = params.value("audioEnabled", true);
    request.colorMode = params.value("colorMode", std::string{"SDR"});
    if (request.bitrateMbps <= 0) {
      request.bitrateMbps = calculateBitrateMbps(request);
    }
    return request;
  }

  [[nodiscard]] static std::vector<std::string> validate(const ExportRequest& request, const GpuStatus& gpu) {
    std::vector<std::string> errors;

    if (request.outputPath.empty()) {
      errors.push_back("choose an output path before exporting");
    }

    if (request.width <= 0 || request.height <= 0) {
      errors.push_back("output width and height must be positive");
    }

    if (request.width % 2 != 0 || request.height % 2 != 0) {
      errors.push_back("output width and height must be even for hardware encoders");
    }

    if (request.container != "mp4" && request.container != "mkv") {
      errors.push_back("container must be mp4 or mkv");
    }

    if (request.codec != "h264_nvenc" && request.codec != "hevc_nvenc" && request.codec != "av1_nvenc") {
      errors.push_back("unsupported export codec: " + request.codec);
    }

    if ((request.codec == "h264_nvenc" || request.codec == "hevc_nvenc") && !gpu.nvencAvailable) {
      errors.push_back("H.264/H.265 NVENC export requires a supported NVIDIA GPU");
    }

    if (request.codec == "av1_nvenc" && !gpu.av1NvencAvailable) {
      errors.push_back("AV1 NVENC is unsupported on this GPU");
    }

    if (request.colorMode == "HDR" && request.codec == "h264_nvenc") {
      errors.push_back("HDR export requires H.265 or AV1");
    }

    return errors;
  }

  [[nodiscard]] static int calculateBitrateMbps(const ExportRequest& request) {
    const auto [width, height] = request.width > 0 && request.height > 0 ? std::pair<int, int>{request.width, request.height} : resolutionSize(request.resolution);
    const auto pixelFactor = static_cast<double>(width * height) / static_cast<double>(1920 * 1080);
    const auto fpsFactor = std::max(0.8, static_cast<double>(request.fps) / 30.0);
    const auto hdrFactor = request.colorMode == "HDR" ? 1.25 : 1.0;
    const auto qualityFactor = qualityMultiplier(request.quality);
    const auto codecFactor = codecEfficiencyMultiplier(request.codec);
    const auto bitrate = 16.0 * pixelFactor * fpsFactor * hdrFactor * qualityFactor * codecFactor;
    return std::max(2, static_cast<int>(std::round(bitrate)));
  }

  [[nodiscard]] static std::string buildFfmpegCommand(const ExportJob& job) {
    std::vector<std::string> args = {
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-hwaccel",
        "cuda",
        "-i",
        "<timeline-render-graph>",
        "-c:v",
        job.codec,
        "-preset",
        presetForQuality(job.quality),
        "-vf",
        "scale=" + std::to_string(job.width) + ":" + std::to_string(job.height),
        "-b:v",
        std::to_string(job.bitrateMbps) + "M",
    };

    if (job.colorMode == "HDR") {
      args.insert(args.end(), {"-pix_fmt", "p010le", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_trc", "smpte2084"});
    } else {
      args.insert(args.end(), {"-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"});
    }

    if (job.audioEnabled) {
      args.insert(args.end(), {"-c:a", "aac", "-b:a", "320k"});
    } else {
      args.push_back("-an");
    }

    args.push_back(job.outputPath);
    return joinQuoted(args);
  }

 private:
  [[nodiscard]] static nlohmann::json idleStatus() {
    return {
        {"jobId", nullptr},
        {"state", "idle"},
        {"progress", 0.0},
        {"logs", nlohmann::json::array()},
    };
  }

  [[nodiscard]] static std::pair<int, int> resolutionSize(const std::string& resolution) {
    if (resolution == "source" || resolution == "custom") {
      return {1920, 1080};
    }
    if (resolution == "4k") {
      return {3840, 2160};
    }
    if (resolution == "1440p") {
      return {2560, 1440};
    }
    return {1920, 1080};
  }

  [[nodiscard]] static double qualityMultiplier(const std::string& quality) {
    if (quality == "trash") {
      return 0.25;
    }
    if (quality == "low") {
      return 0.5;
    }
    if (quality == "high") {
      return 1.6;
    }
    if (quality == "pro_max") {
      return 2.4;
    }
    return 1.0;
  }

  [[nodiscard]] static double codecEfficiencyMultiplier(const std::string& codec) {
    if (codec == "hevc_nvenc") {
      return 0.72;
    }
    if (codec == "av1_nvenc") {
      return 0.58;
    }
    return 1.0;
  }

  [[nodiscard]] static std::string presetForQuality(const std::string& quality) {
    if (quality == "trash" || quality == "low") {
      return "p3";
    }
    if (quality == "high") {
      return "p6";
    }
    if (quality == "pro_max") {
      return "p7";
    }
    return "p5";
  }

  [[nodiscard]] static std::string join(const std::vector<std::string>& values, const std::string& separator) {
    std::ostringstream stream;
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index > 0) {
        stream << separator;
      }
      stream << values.at(index);
    }
    return stream.str();
  }

  [[nodiscard]] static std::string joinQuoted(const std::vector<std::string>& args) {
    std::ostringstream stream;
    for (std::size_t index = 0; index < args.size(); ++index) {
      if (index > 0) {
        stream << ' ';
      }
      stream << quoteIfNeeded(args.at(index));
    }
    return stream.str();
  }

  [[nodiscard]] static std::string quoteIfNeeded(const std::string& value) {
    if (value.find_first_of(" <>") == std::string::npos) {
      return value;
    }

    std::string quoted = "\"";
    for (const auto character : value) {
      if (character == '"') {
        quoted += "\\\"";
      } else {
        quoted += character;
      }
    }
    quoted += '"';
    return quoted;
  }

  const FfmpegLocator& locator_;
  const GpuDetector& gpuDetector_;
  std::optional<ExportJob> activeJob_;
};

}  // namespace ai_editor
