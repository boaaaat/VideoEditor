#pragma once

#include "render/ExportJob.hpp"
#include "platform/FfmpegLocator.hpp"
#include "platform/GpuDetector.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <cmath>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ai_editor {

class ExportEngine {
 public:
  ExportEngine(const FfmpegLocator& locator, const GpuDetector& gpuDetector)
      : locator_(locator), gpuDetector_(gpuDetector) {}

  ~ExportEngine() {
    cancelRequested_ = true;
    if (worker_.joinable()) {
      worker_.join();
    }
  }

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
    job.durationUs = request.durationUs;
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

    const auto ffmpeg = locator_.locate("ffmpeg");
    if (!ffmpeg.available) {
      throw std::runtime_error(ffmpeg.message.empty() ? "ffmpeg was not found" : ffmpeg.message);
    }

    {
      std::lock_guard lock(mutex_);
      if (activeJob_ && activeJob_->state == "running") {
        throw std::runtime_error("an export is already running");
      }
    }
    if (worker_.joinable()) {
      worker_.join();
    }

    prepareDestination(request);

    auto job = createJob(request);
    const auto progressPath = progressPathFor(job.id);
    std::error_code ignored;
    std::filesystem::remove(progressPath, ignored);
    job.ffmpegCommand = buildFfmpegCommand(job, ffmpeg.path, progressPath.string(), request.overwrite);
    job.logs.push_back("Export started");
    job.logs.push_back("Render duration: " + formatSeconds(job.durationUs));
    job.logs.push_back("FFmpeg command: " + job.ffmpegCommand);

    {
      std::lock_guard lock(mutex_);
      activeJob_ = job;
      activeProgressPath_ = progressPath;
      cancelRequested_ = false;
      lastLoggedProgressPercent_ = -1;
      worker_ = std::thread([this, jobId = job.id, command = job.ffmpegCommand, outputPath = job.outputPath]() {
        runExportProcess(jobId, command, outputPath);
      });
    }

    return status();
  }

  nlohmann::json cancel() {
    std::lock_guard lock(mutex_);
    if (!activeJob_) {
      return idleStatus();
    }

    cancelRequested_ = true;
    if (activeJob_->state == "running") {
      activeJob_->cancelled = true;
      activeJob_->state = "cancelled";
      activeJob_->logs.push_back("Export cancel requested");
    }
    return activeJob_->toJson();
  }

  nlohmann::json status() {
    std::lock_guard lock(mutex_);
    if (!activeJob_) {
      return idleStatus();
    }

    updateProgressFromFile();
    return activeJob_->toJson();
  }

  [[nodiscard]] static ExportRequest requestFromJson(const nlohmann::json& params) {
    ExportRequest request;
    request.outputPath = params.value("outputPath", std::string{});
    request.resolution = params.value("resolution", std::string{"1080p"});
    request.width = params.value("width", 1920);
    request.height = params.value("height", 1080);
    request.fps = params.value("fps", 30);
    request.durationUs = params.value("durationUs", 60'000'000LL);
    request.codec = params.value("codec", std::string{"h264_nvenc"});
    request.container = params.value("container", std::string{"mp4"});
    request.quality = params.value("quality", std::string{"medium"});
    request.bitrateMbps = params.value("bitrateMbps", 0);
    request.audioEnabled = params.value("audioEnabled", true);
    request.colorMode = params.value("colorMode", std::string{"SDR"});
    request.overwrite = params.value("overwrite", false);
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

    if (request.durationUs <= 0) {
      errors.push_back("timeline duration must be positive");
    }

    if (request.fps <= 0) {
      errors.push_back("export fps must be positive");
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

    const auto extension = lower(std::filesystem::path(request.outputPath).extension().string());
    if (!request.outputPath.empty() && (extension.empty() || extension != "." + request.container)) {
      errors.push_back("output file extension must match selected container");
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
    return buildFfmpegCommand(job, "ffmpeg", "", true);
  }

 private:
  [[nodiscard]] static std::string buildFfmpegCommand(const ExportJob& job, const std::string& ffmpegPath, const std::string& progressPath, bool overwrite) {
    const auto durationSeconds = formatSeconds(job.durationUs);
    std::vector<std::string> args = {
        ffmpegPath.empty() ? "ffmpeg" : ffmpegPath,
        "-hide_banner",
        overwrite ? "-y" : "-n",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=" + std::to_string(job.width) + "x" + std::to_string(job.height) + ":r=" + std::to_string(job.fps) + ":d=" + durationSeconds,
    };

    if (job.audioEnabled) {
      args.insert(args.end(), {"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"});
    }

    args.insert(args.end(), {
        "-t",
        durationSeconds,
        "-r",
        std::to_string(job.fps),
        "-c:v",
        job.codec,
        "-preset",
        presetForQuality(job.quality),
        "-b:v",
        std::to_string(job.bitrateMbps) + "M",
    });

    if (job.colorMode == "HDR") {
      args.insert(args.end(), {"-pix_fmt", "p010le", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_trc", "smpte2084"});
    } else {
      args.insert(args.end(), {"-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"});
    }

    if (job.audioEnabled) {
      args.insert(args.end(), {"-c:a", "aac", "-b:a", "320k", "-shortest"});
    } else {
      args.push_back("-an");
    }

    if (!progressPath.empty()) {
      args.insert(args.end(), {"-progress", progressPath, "-nostats"});
    }

    args.push_back(job.outputPath);
    return joinQuoted(args);
  }

  static void prepareDestination(const ExportRequest& request) {
    const auto output = std::filesystem::path(request.outputPath);
    const auto parent = output.parent_path();
    if (!parent.empty()) {
      std::error_code error;
      std::filesystem::create_directories(parent, error);
      if (error) {
        throw std::runtime_error("failed to create export destination folder: " + error.message());
      }
    }

    if (std::filesystem::exists(output) && !request.overwrite) {
      throw std::runtime_error("output file already exists; confirm overwrite before exporting");
    }
  }

  [[nodiscard]] static std::filesystem::path progressPathFor(const std::string& jobId) {
    return std::filesystem::temp_directory_path() / (jobId + ".progress");
  }

  void runExportProcess(const std::string& jobId, const std::string& command, const std::string& outputPath) {
    const auto exitCode = std::system(command.c_str());
    std::lock_guard lock(mutex_);
    if (!activeJob_ || activeJob_->id != jobId) {
      return;
    }

    updateProgressFromFile();
    if (cancelRequested_ || activeJob_->cancelled) {
      activeJob_->state = "cancelled";
      activeJob_->cancelled = true;
      activeJob_->progress = std::min(activeJob_->progress, 0.99);
      activeJob_->logs.push_back("Export cancelled");
      std::error_code ignored;
      std::filesystem::remove(outputPath, ignored);
    } else if (exitCode == 0) {
      activeJob_->state = "completed";
      activeJob_->progress = 1.0;
      activeJob_->logs.push_back("Export completed: " + activeJob_->outputPath);
    } else {
      activeJob_->state = "error";
      activeJob_->logs.push_back("FFmpeg export failed with exit code " + std::to_string(exitCode));
    }
    activeJob_->finishedAt = std::chrono::steady_clock::now();
  }

  void updateProgressFromFile() {
    if (!activeJob_ || activeProgressPath_.empty() || activeJob_->state != "running") {
      return;
    }

    std::ifstream stream(activeProgressPath_);
    if (!stream) {
      return;
    }

    std::string line;
    std::int64_t outTimeUs = 0;
    std::string progressStatus;
    while (std::getline(stream, line)) {
      const auto separator = line.find('=');
      if (separator == std::string::npos) {
        continue;
      }
      const auto key = line.substr(0, separator);
      const auto value = line.substr(separator + 1);
      if (key == "out_time_us") {
        try {
          outTimeUs = std::stoll(value);
        } catch (...) {
          outTimeUs = 0;
        }
      } else if (key == "progress") {
        progressStatus = value;
      }
    }

    if (outTimeUs > 0 && activeJob_->durationUs > 0) {
      activeJob_->progress = std::clamp(static_cast<double>(outTimeUs) / static_cast<double>(activeJob_->durationUs), 0.0, 0.99);
      const auto percent = static_cast<int>(std::floor(activeJob_->progress * 100.0));
      if (percent >= lastLoggedProgressPercent_ + 10 || percent == 0) {
        lastLoggedProgressPercent_ = percent;
        activeJob_->logs.push_back("Export progress " + std::to_string(percent) + "%");
      }
    }

    if (progressStatus == "end") {
      activeJob_->progress = std::max(activeJob_->progress, 0.99);
    }
  }

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

  [[nodiscard]] static std::string formatSeconds(std::int64_t durationUs) {
    std::ostringstream stream;
    stream.setf(std::ios::fixed);
    stream.precision(3);
    stream << static_cast<double>(std::max<std::int64_t>(1, durationUs)) / 1'000'000.0;
    return stream.str();
  }

  [[nodiscard]] static std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
      return static_cast<char>(std::tolower(character));
    });
    return value;
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
  std::mutex mutex_;
  std::thread worker_;
  std::atomic_bool cancelRequested_ = false;
  std::filesystem::path activeProgressPath_;
  int lastLoggedProgressPercent_ = -1;
  std::optional<ExportJob> activeJob_;
};

}  // namespace ai_editor
