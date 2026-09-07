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
#include <cmath>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

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
    job.rangeStartUs = request.rangeStartUs;
    job.codec = request.codec;
    job.container = request.container;
    job.quality = request.quality;
    job.bitrateMbps = request.bitrateMbps > 0 ? request.bitrateMbps : calculateBitrateMbps(request);
    job.audioEnabled = request.audioEnabled;
    job.colorMode = request.colorMode;
    job.masterGainDb = request.masterGainDb;
    job.normalizeAudio = request.normalizeAudio;
    job.cleanupAudio = request.cleanupAudio;
    job.encoderOptions = request.encoderOptions;
    job.timeline = request.timeline;
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
    for (std::size_t index = 0; index < job.timeline.titles.size(); ++index) {
      std::ofstream textFile(titleTextPath(job.id, index), std::ios::binary);
      textFile << job.timeline.titles[index].text;
      if (!textFile) throw std::runtime_error("could not prepare title text for export");
    }
    const auto progressPath = progressPathFor(job.id);
    std::error_code ignored;
    std::filesystem::remove(progressPath, ignored);
    job.ffmpegCommand = buildFfmpegCommand(job, ffmpeg.path, progressPath.string(), request.overwrite, true);
    const auto compatibilityCommand = hasRenderableTimeline(job)
                                          ? buildFfmpegCommand(job, ffmpeg.path, progressPath.string(), request.overwrite, false)
                                          : std::string{};
    job.logs.push_back("Export started");
    job.logs.push_back("GPU pipeline: NVDEC decode, CUDA scale, " + job.codec + " encode");
    if (job.encoderOptions.enabled) {
      job.logs.push_back("Custom encoder: " + job.encoderOptions.preset + ", CQ " + std::to_string(job.encoderOptions.cq) +
                         ", peak " + std::to_string(job.encoderOptions.maxBitrateMbps) + " Mbps");
    } else {
      job.logs.push_back("Quality tier: " + job.quality);
    }
    job.logs.push_back("Render duration: " + formatSeconds(job.durationUs));
    if (job.rangeStartUs > 0) job.logs.push_back("Timeline range starts at " + formatSeconds(job.rangeStartUs));
    if (hasRenderableTimeline(job)) {
      job.logs.push_back("Rendering timeline media clips: " + std::to_string(countRenderableVideoClips(job)) + " video, " + std::to_string(countRenderableAudioClips(job)) + " audio");
    } else {
      job.logs.push_back("Timeline has no visible video clips; rendering black output");
    }
    job.logs.push_back("FFmpeg command: " + job.ffmpegCommand);

    {
      std::lock_guard lock(mutex_);
      activeJob_ = job;
      activeProgressPath_ = progressPath;
      cancelRequested_ = false;
      lastLoggedProgressPercent_ = -1;
      worker_ = std::thread([this, jobId = job.id, command = job.ffmpegCommand, compatibilityCommand, outputPath = job.outputPath]() {
        runExportProcess(jobId, command, compatibilityCommand, outputPath);
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
#ifdef _WIN32
    if (activeProcess_) {
      TerminateProcess(activeProcess_, 1);
    }
#endif
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
    request.durationUs = params.value("durationUs", 10'000'000LL);
    request.codec = params.value("codec", std::string{"h264_nvenc"});
    request.container = params.value("container", std::string{"mp4"});
    request.quality = params.value("quality", std::string{"medium"});
    request.bitrateMbps = params.value("bitrateMbps", 0);
    request.audioEnabled = params.value("audioEnabled", true);
    request.colorMode = params.value("colorMode", std::string{"SDR"});
    request.overwrite = params.value("overwrite", false);
    request.masterGainDb = params.value("masterGainDb", 0.0);
    request.normalizeAudio = params.value("normalizeAudio", false);
    request.cleanupAudio = params.value("cleanupAudio", false);
    if (params.contains("encoderOptions") && params.at("encoderOptions").is_object()) {
      const auto& options = params.at("encoderOptions");
      request.encoderOptions.enabled = options.value("enabled", false);
      request.encoderOptions.preset = options.value("preset", std::string{"p5"});
      request.encoderOptions.tune = options.value("tune", std::string{"hq"});
      request.encoderOptions.cq = options.value("cq", 20);
      request.encoderOptions.maxBitrateMbps = options.value("maxBitrateMbps", 32);
      request.encoderOptions.lookaheadDepth = options.value("lookaheadDepth", 16);
      request.encoderOptions.lookaheadLevel = options.value("lookaheadLevel", 0);
      request.encoderOptions.multipass = options.value("multipass", std::string{"qres"});
      request.encoderOptions.spatialAq = options.value("spatialAq", true);
      request.encoderOptions.temporalAq = options.value("temporalAq", true);
      request.encoderOptions.aqStrength = options.value("aqStrength", 8);
      request.encoderOptions.bFrames = options.value("bFrames", 3);
      request.encoderOptions.bRefMode = options.value("bRefMode", std::string{"middle"});
      request.encoderOptions.referenceFrames = options.value("referenceFrames", 4);
      request.encoderOptions.highBitDepth = options.value("highBitDepth", true);
      request.encoderOptions.splitEncodeMode = options.value("splitEncodeMode", std::string{"disabled"});
    }
    request.timeline = timelineFromJson(params);
    const auto videoDurationUs = visibleVideoDurationUs(request.timeline);
    if (videoDurationUs > 0) {
      request.durationUs = videoDurationUs;
    }
    request.rangeStartUs = params.value("rangeStartUs", 0LL);
    const auto rangeEndUs = params.value("rangeEndUs", request.durationUs);
    if (request.rangeStartUs < 0 || rangeEndUs <= request.rangeStartUs || rangeEndUs > request.durationUs) throw std::runtime_error("export range must be within the timeline content and end after its start");
    request.durationUs = rangeEndUs - request.rangeStartUs;
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

    if (request.encoderOptions.enabled) {
      const auto& options = request.encoderOptions;
      if (options.preset != "p1" && options.preset != "p2" && options.preset != "p3" && options.preset != "p4" &&
          options.preset != "p5" && options.preset != "p6" && options.preset != "p7") {
        errors.push_back("custom NVENC preset must be p1 through p7");
      }
      if (options.tune != "hq" && options.tune != "uhq") {
        errors.push_back("custom NVENC tune must be hq or uhq");
      }
      const auto maxCq = request.codec == "av1_nvenc" ? 63 : 51;
      if (options.cq < 0 || options.cq > maxCq) {
        errors.push_back("custom CQ is outside the codec's supported range");
      }
      if (options.maxBitrateMbps < 1 || options.maxBitrateMbps > 2000) {
        errors.push_back("custom peak bitrate must be between 1 and 2000 Mbps");
      }
      if (options.lookaheadDepth < 0 || options.lookaheadDepth > 32 || options.lookaheadLevel < 0 || options.lookaheadLevel > 3) {
        errors.push_back("custom lookahead settings are outside the supported range");
      }
      if (options.multipass != "disabled" && options.multipass != "qres" && options.multipass != "fullres") {
        errors.push_back("custom multipass mode is invalid");
      }
      if (options.aqStrength < 1 || options.aqStrength > 15 || options.bFrames < 0 || options.bFrames > 5 ||
          options.referenceFrames < 1 || options.referenceFrames > 16) {
        errors.push_back("custom AQ or reference-frame settings are outside the supported range");
      }
      if (options.bRefMode != "disabled" && options.bRefMode != "each" && options.bRefMode != "middle") {
        errors.push_back("custom B-frame reference mode is invalid");
      }
      if (options.splitEncodeMode != "auto" && options.splitEncodeMode != "disabled") {
        errors.push_back("custom split encode mode is invalid");
      }
    }

    const auto extension = lower(std::filesystem::path(request.outputPath).extension().string());
    if (!request.outputPath.empty() && (extension.empty() || extension != "." + request.container)) {
      errors.push_back("output file extension must match selected container");
    }

    for (const auto& clip : request.timeline.clips) {
      if (clip.outUs <= clip.inUs) {
        errors.push_back("timeline contains a clip with invalid in/out points");
        break;
      }
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
    return buildFfmpegCommand(job, "ffmpeg", "", true, true);
  }

  // Stateless frame planning uses the same layer, text, color and effect filters as export.
  // The desktop runs the returned arguments in a cancellable process outside the command engine.
  [[nodiscard]] static nlohmann::json compositionFramePlan(const nlohmann::json& params) {
    ExportJob job;
    job.id = "composition_frame";
    job.width = params.value("width", 1920);
    job.height = params.value("height", 1080);
    job.fps = params.value("fps", 30);
    if (!params.at("timeUs").is_number_integer()) throw std::runtime_error("frame time must be integer microseconds");
    const auto requestedTimeUs = params.at("timeUs").get<std::int64_t>();
    const auto maxWidth = params.value("maxWidth", 1280);
    if (job.width < 16 || job.width > 8192 || job.height < 16 || job.height > 8192 || job.width % 2 || job.height % 2 || job.fps < 1 || job.fps > 120 || requestedTimeUs < 0 || requestedTimeUs > 9'007'199'254'740'991LL || maxWidth < 16 || maxWidth > 4096) throw std::runtime_error("invalid composition frame dimensions, rate, or time");
    const auto frameIndex = static_cast<std::int64_t>(std::floor((static_cast<long double>(requestedTimeUs) + 0.5L) * job.fps / 1'000'000));
    const auto timeUs = static_cast<std::int64_t>(std::llround(static_cast<long double>(frameIndex) * 1'000'000 / job.fps));
    job.durationUs = static_cast<std::int64_t>(std::ceil(1'000'000.0 / job.fps));
    job.rangeStartUs = 0;
    job.audioEnabled = false;
    job.resourceDirectory = params.at("resourceDirectory").get<std::string>();
    job.outputPath = (std::filesystem::u8path(job.resourceDirectory) / "frame.png").string();
    job.timeline = timelineFromJson(params);
    auto& clips = job.timeline.clips;
    clips.erase(std::remove_if(clips.begin(), clips.end(), [&](const auto& clip) { return clip.trackKind != "video" || !clip.trackVisible || timeUs < clip.startUs || timeUs >= clip.startUs + clipDisplayDurationUs(clip); }), clips.end());
    std::stable_sort(clips.begin(), clips.end(), [](const auto& a, const auto& b) { return a.trackIndex == b.trackIndex ? a.startUs < b.startUs : a.trackIndex > b.trackIndex; });
    for (auto& clip : clips) {
      const auto relativeUs = timeUs - clip.startUs;
      const auto durationUs = clip.videoFadeDurationUs > 0 ? clip.videoFadeDurationUs : clipDisplayDurationUs(clip);
      const auto fadeTimeUs = relativeUs + clip.videoFadeOffsetUs;
      if (clip.transformEnabled) {
        if (clip.videoFadeInUs > 0) clip.opacity *= std::clamp(static_cast<double>(fadeTimeUs) / std::min(clip.videoFadeInUs, durationUs), 0.0, 1.0);
        if (clip.videoFadeOutUs > 0) clip.opacity *= std::clamp(static_cast<double>(durationUs - fadeTimeUs) / std::min(clip.videoFadeOutUs, durationUs), 0.0, 1.0);
      }
      clip.videoFadeInUs = clip.videoFadeOutUs = 0;
      clip.videoFadeOffsetUs = clip.videoFadeDurationUs = 0;
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      if (media && media->isStillImage) { clip.inUs = 0; clip.outUs = job.durationUs * 3; }
      else {
        clip.inUs += static_cast<std::int64_t>(std::llround(relativeUs * normalizedSpeedFactor(clip)));
        clip.outUs = std::min(clip.outUs, clip.inUs + static_cast<std::int64_t>(std::ceil(job.durationUs * 3 * normalizedSpeedFactor(clip))));
      }
      clip.startUs = 0;
    }
    auto& titles = job.timeline.titles;
    titles.erase(std::remove_if(titles.begin(), titles.end(), [&](const auto& title) { return timeUs < title.startUs || timeUs >= title.startUs + title.durationUs; }), titles.end());
    auto files = nlohmann::json::array();
    for (std::size_t index = 0; index < titles.size(); ++index) {
      titles[index].startUs = 0;
      titles[index].durationUs = job.durationUs * 3;
      files.push_back({{"name", "title_" + std::to_string(index) + ".txt"}, {"content", titles[index].text}});
    }
    std::string graph;
    auto arguments = buildTimelineFfmpegArguments(job, "", "", true, false, &graph, maxWidth);
    arguments.erase(arguments.begin()); // The desktop selects the installed FFmpeg binary.
    files.push_back({{"name", "graph.filter"}, {"content", graph}});
    return {{"arguments", arguments}, {"files", files}, {"timeUs", timeUs}, {"requestedTimeUs", requestedTimeUs}, {"width", std::min(job.width, maxWidth)}, {"projectWidth", job.width}, {"projectHeight", job.height}, {"fps", job.fps}};
  }

  // Render the entire mix before seeking so loudness analysis and cleanup have
  // exactly the same input history as a full export. Scaling happens after composition.
  [[nodiscard]] static nlohmann::json compositionPlaybackPlan(const nlohmann::json& params) {
    ExportJob job;
    job.width = params.value("width", 1920);
    job.height = params.value("height", 1080);
    job.fps = params.value("fps", 30);
    const auto maxWidth = params.value("maxWidth", 1280);
    if (job.width < 16 || job.width > 8192 || job.height < 16 || job.height > 8192 || job.width % 2 || job.height % 2 || job.fps < 1 || job.fps > 120 || maxWidth < 16 || maxWidth > 4096 || maxWidth % 2) throw std::runtime_error("invalid playback dimensions or frame rate");
    if (params.value("colorMode", std::string{"SDR"}) != "SDR") throw std::runtime_error("Rendered playback currently supports SDR projects only");
    job.timeline = timelineFromJson(params);
    job.durationUs = visibleVideoDurationUs(job.timeline);
    if (job.durationUs <= 0) throw std::runtime_error("Add visible video, audible audio, or titles before rendering playback");
    job.audioEnabled = params.value("audioEnabled", true);
    job.masterGainDb = params.value("masterGainDb", 0.0);
    job.normalizeAudio = params.value("normalizeAudio", false);
    job.cleanupAudio = params.value("cleanupAudio", false);
    job.resourceDirectory = params.at("resourceDirectory").get<std::string>();
    job.outputPath = (std::filesystem::u8path(job.resourceDirectory) / "playback.mp4").string();
    auto files = nlohmann::json::array();
    for (std::size_t index = 0; index < job.timeline.titles.size(); ++index) {
      files.push_back({{"name", "title_" + std::to_string(index) + ".txt"}, {"content", job.timeline.titles[index].text}});
    }
    std::string graph;
    auto arguments = buildTimelineFfmpegArguments(job, "", (std::filesystem::u8path(job.resourceDirectory) / "progress.txt").string(), true, false, &graph, maxWidth, true);
    arguments.erase(arguments.begin());
    files.push_back({{"name", "graph.filter"}, {"content", graph}});
    const auto width = std::min(job.width, maxWidth);
    const auto height = static_cast<int>(std::llround(static_cast<double>(job.height) * width / job.width / 2)) * 2;
    return {{"arguments", arguments}, {"files", files}, {"durationUs", job.durationUs}, {"width", width}, {"height", height}, {"fps", job.fps}, {"audioEnabled", job.audioEnabled}};
  }

 private:
  [[nodiscard]] static std::string buildFfmpegCommand(
      const ExportJob& job,
      const std::string& ffmpegPath,
      const std::string& progressPath,
      bool overwrite,
      bool useCudaDecode) {
    if (hasRenderableTimeline(job)) {
      return buildTimelineFfmpegCommand(job, ffmpegPath, progressPath, overwrite, useCudaDecode);
    }

    const auto durationSeconds = formatSeconds(job.durationUs);
    std::vector<std::string> args = {
        ffmpegPath.empty() ? "ffmpeg" : ffmpegPath,
        "-hide_banner",
        "-loglevel",
        "error",
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
        presetForJob(job),
    });
    appendNvencOptions(job, args);

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
      args.insert(args.end(), {"-stats_period", "0.2", "-progress", progressPath, "-nostats"});
    }

    args.push_back(job.outputPath);
    return joinQuoted(args);
  }

  [[nodiscard]] static std::string buildTimelineFfmpegCommand(
      const ExportJob& job,
      const std::string& ffmpegPath,
      const std::string& progressPath,
      bool overwrite,
      bool useCudaDecode) {
    return joinQuoted(buildTimelineFfmpegArguments(job, ffmpegPath, progressPath, overwrite, useCudaDecode));
  }

  [[nodiscard]] static std::vector<std::string> buildTimelineFfmpegArguments(
      const ExportJob& job,
      const std::string& ffmpegPath,
      const std::string& progressPath,
      bool overwrite,
      bool useCudaDecode,
      std::string* frameGraph = nullptr,
      int frameMaxWidth = 1280,
      bool motionPreview = false) {
    std::vector<const ExportTimelineClip*> videoClips;
    for (const auto& clip : job.timeline.clips) {
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      if (media && media->kind == "video" && clip.trackKind == "video" && clip.trackVisible && clip.outUs > clip.inUs && clip.startUs < job.rangeStartUs + job.durationUs && clip.startUs + clipDisplayDurationUs(clip) > job.rangeStartUs) videoClips.push_back(&clip);
    }
    // Track zero is the top layer. Later clips win overlaps on the same track.
    std::stable_sort(videoClips.begin(), videoClips.end(), [](const auto* a, const auto* b) { return a->trackIndex == b->trackIndex ? a->startUs < b->startUs : a->trackIndex > b->trackIndex; });
    const auto audioClips = collectAudioClips(job);
    std::vector<std::string> args = {
        ffmpegPath.empty() ? "ffmpeg" : ffmpegPath,
        "-hide_banner",
        "-loglevel",
        "error",
        overwrite ? "-y" : "-n",
        "-filter_complex_threads",
        frameGraph ? "2" : "0",
    };
    if (useCudaDecode) {
      // Stop on the first hardware decode error so compatibility decoding can
      // begin immediately instead of waiting for FFmpeg to reach end-of-file.
      args.push_back("-xerror");
    }
    std::vector<std::string> filters;
    int inputIndex = 0;
    filters.push_back("color=c=black:s=" + std::to_string(job.width) + "x" + std::to_string(job.height) + ":r=" + std::to_string(job.fps) + ":d=" + formatSeconds(job.rangeStartUs + job.durationUs) + ",format=rgba[canvas0]");
    for (std::size_t layer = 0; layer < videoClips.size(); ++layer) {
        const auto* clip = videoClips[layer];
        const auto* media = findMedia(job.timeline.media, clip->mediaId);
        const auto layerCudaDecode = useCudaDecode && !media->isStillImage;
        if (media->isStillImage) args.insert(args.end(), {"-loop", "1", "-framerate", std::to_string(job.fps)});
        if (layerCudaDecode) {
          args.insert(args.end(), {
                                      "-hwaccel",
                                      "cuda",
                                      "-hwaccel_device",
                                      "0",
                                      "-hwaccel_output_format",
                                      "cuda",
                                  });
        } else {
          // Compatibility decoding is the recovery path for unsupported or
          // damaged source frames. Keep the usable frames instead of failing
          // an otherwise complete export at end-of-file.
          args.insert(args.end(), {"-fflags", "+discardcorrupt", "-err_detect", "ignore_err"});
        }
        args.insert(args.end(), {
                                    "-ss",
                                    formatSeconds(clip->inUs),
                                    "-t",
                                    formatSeconds(clipSourceDurationUs(*clip)),
                                    "-i",
                                    media ? media->path : std::string{},
                                });
        filters.push_back(videoLayerFilter(inputIndex, static_cast<int>(layer), *clip, job, layerCudaDecode));
        const auto x = clip->transformEnabled ? clip->positionX : 0.0;
        const auto y = clip->transformEnabled ? clip->positionY : 0.0;
        filters.push_back("[canvas" + std::to_string(layer) + "][layer" + std::to_string(layer) + "]overlay=x=(W-w)/2+" + formatDouble(x) + ":y=(H-h)/2+" + formatDouble(y) + ":format=auto:eof_action=pass:repeatlast=0:enable='gte(t," + formatSeconds(clip->startUs) + ")*lt(t," + formatSeconds(clip->startUs + clipDisplayDurationUs(*clip)) + ")'[canvas" + std::to_string(layer + 1) + "]");
        inputIndex += 1;
    }
    filters.push_back("[canvas" + std::to_string(videoClips.size()) + "]format=yuv420p[outv]");
    if (!job.timeline.titles.empty()) filters.back() = "[canvas" + std::to_string(videoClips.size()) + "]" + titleFilterChain(job) + ",format=yuv420p[outv]";
    if (job.rangeStartUs > 0) {
      auto& finalVideo = filters.back();
      finalVideo.replace(finalVideo.rfind("[outv]"), 6, ",trim=start=" + formatSeconds(job.rangeStartUs) + ":duration=" + formatSeconds(job.durationUs) + ",setpts=PTS-STARTPTS[outv]");
    }

    if (frameGraph) {
      auto& finalVideo = filters.back();
      finalVideo.replace(finalVideo.rfind("[outv]"), 6, ",scale=min(" + std::to_string(frameMaxWidth) + "\\,iw):-2[outv]");
    }

    if (job.audioEnabled) {
      appendAudioMixGraph(job, audioClips, args, filters, inputIndex);
    }

    const auto graph = join(filters, ";");
    if (frameGraph) {
      *frameGraph = graph;
      args.insert(args.end(), {"-filter_complex_script", (std::filesystem::u8path(job.resourceDirectory) / "graph.filter").string()});
    } else if (!progressPath.empty() && graph.size() > 12'000) {
      // Caption-rich sequences exceed Windows' process command-line limit.
      const auto graphPath = filterGraphPath(job.id, useCudaDecode);
      std::ofstream script(graphPath, std::ios::binary);
      script << graph;
      script.close();
      if (!script) throw std::runtime_error("could not prepare export filter graph");
      args.insert(args.end(), {"-filter_complex_script", graphPath.string()});
    } else args.insert(args.end(), {"-filter_complex", graph});
    args.insert(args.end(), {"-map", "[outv]"});
    if (frameGraph && !motionPreview) {
      args.insert(args.end(), {"-an", "-frames:v", "1", "-c:v", "png", "-threads", "1", "-update", "1", job.outputPath});
      return args;
    }
    if (job.audioEnabled) {
      args.insert(args.end(), {"-map", "[outa]"});
    }

    if (motionPreview) {
      args.insert(args.end(), {"-t", formatSeconds(job.durationUs), "-r", std::to_string(job.fps), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-threads", "2", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709", "-movflags", "+faststart"});
      if (job.audioEnabled) args.insert(args.end(), {"-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2"});
      else args.push_back("-an");
      args.insert(args.end(), {"-stats_period", "0.2", "-progress", progressPath, "-nostats", job.outputPath});
      return args;
    }

    args.insert(args.end(), {
        "-t",
        formatSeconds(job.durationUs),
        "-r",
        std::to_string(job.fps),
        "-c:v",
        job.codec,
        "-preset",
        presetForJob(job),
    });
    appendNvencOptions(job, args);

    if (job.colorMode == "HDR") {
      args.insert(args.end(), {"-pix_fmt", "p010le", "-color_primaries", "bt2020", "-colorspace", "bt2020nc", "-color_trc", "smpte2084"});
    } else {
      args.insert(args.end(), {"-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-colorspace", "bt709", "-color_trc", "bt709"});
    }

    if (job.audioEnabled) {
      args.insert(args.end(), {"-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2"});
    } else {
      args.push_back("-an");
    }

    if (!progressPath.empty()) {
      args.insert(args.end(), {"-stats_period", "0.2", "-progress", progressPath, "-nostats"});
    }

    args.push_back(job.outputPath);
    return args;
  }

  static void appendAudioMixGraph(
      const ExportJob& job,
      const std::vector<const ExportTimelineClip*>& clips,
      std::vector<std::string>& args,
      std::vector<std::string>& filters,
      int& inputIndex) {
    if (clips.empty()) {
      args.insert(args.end(), {"-f", "lavfi", "-t", formatSeconds(job.rangeStartUs + job.durationUs), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"});
      filters.push_back("[" + std::to_string(inputIndex) + ":a]" + finalAudioFilterChain(job) + "[outa]");
      inputIndex += 1;
      return;
    }

    std::vector<std::string> audioInputs;
    for (std::size_t index = 0; index < clips.size(); ++index) {
      const auto* clip = clips.at(index);
      const auto* media = findMedia(job.timeline.media, clip->mediaId);
      if (!media) {
        continue;
      }

      const auto sourceDurationUs = clipSourceDurationUs(*clip);
      const auto durationUs = clipDisplayDurationUs(*clip);
      const auto delayMs = std::max<std::int64_t>(0, clip->startUs / 1000);
      const auto label = "aud" + std::to_string(index);
      args.insert(args.end(), {
                                  "-ss",
                                  formatSeconds(clip->inUs),
                                  "-t",
                                  formatSeconds(sourceDurationUs),
                                  "-i",
                                  media->path,
                              });
      filters.push_back("[" + std::to_string(inputIndex) + ":a:" + std::to_string(std::max(0, clip->audioStreamIndex)) + "]" + audioFilterChain(*clip, sourceDurationUs, durationUs, delayMs, label));
      audioInputs.push_back("[" + label + "]");
      inputIndex += 1;
    }

    if (audioInputs.empty()) {
      args.insert(args.end(), {"-f", "lavfi", "-t", formatSeconds(job.rangeStartUs + job.durationUs), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"});
      filters.push_back("[" + std::to_string(inputIndex) + ":a]" + finalAudioFilterChain(job) + "[outa]");
      inputIndex += 1;
      return;
    }

    const auto finalFilter = finalAudioFilterChain(job);
    if (audioInputs.size() == 1) {
      filters.push_back(audioInputs.front() + finalFilter + "[outa]");
    } else {
      filters.push_back(join(audioInputs, "") + "amix=inputs=" + std::to_string(audioInputs.size()) + ":duration=longest:dropout_transition=0:normalize=0," + finalFilter + "[outa]");
    }
  }

  [[nodiscard]] static std::string videoLayerFilter(int inputIndex, int layerIndex, const ExportTimelineClip& clip, const ExportJob& job, bool useCudaDecode) {
    const auto durationUs = clipDisplayDurationUs(clip);
    std::vector<std::string> filters = {
      "[" + std::to_string(inputIndex) + ":v]trim=start=0:duration=" + formatSeconds(clipSourceDurationUs(clip)),
      "setpts=(PTS-STARTPTS)/" + formatDouble(normalizedSpeedFactor(clip)),
      "trim=duration=" + formatSeconds(durationUs), "setpts=PTS-STARTPTS", "fps=" + std::to_string(job.fps)
    };
    const auto fit = std::to_string(job.width) + ":" + std::to_string(job.height) + ":force_original_aspect_ratio=decrease:force_divisible_by=2";
    if (useCudaDecode) filters.insert(filters.end(), {"scale_cuda=" + fit, "hwdownload", "format=nv12"});
    else filters.push_back("scale=" + fit);
    filters.push_back("setsar=1");
    appendColorFilters(clip, filters);
    appendEffectFilters(clip, filters);
    filters.push_back("format=rgba");
    if (clip.transformEnabled) {
      if (std::abs(clip.scale - 1) > 0.001) filters.push_back("scale=round(iw*" + formatDouble(std::clamp(clip.scale, 0.1, 4.0)) + "/2)*2:round(ih*" + formatDouble(std::clamp(clip.scale, 0.1, 4.0)) + "/2)*2");
      if (std::abs(clip.rotation) > 0.001) {
        const auto angle = formatDouble(clip.rotation * 3.14159265358979323846 / 180.0);
        filters.push_back("rotate=" + angle + ":ow=rotw(" + angle + "):oh=roth(" + angle + "):c=black@0");
      }
      if (clip.opacity < 0.999) filters.push_back("colorchannelmixer=aa=" + formatDouble(std::clamp(clip.opacity, 0.0, 1.0)));
      const auto fadeDurationUs = clip.videoFadeDurationUs > 0 ? clip.videoFadeDurationUs : durationUs;
      const bool offsetFade = clip.videoFadeOffsetUs > 0 && (clip.videoFadeInUs > 0 || clip.videoFadeOutUs > 0);
      if (offsetFade) filters.push_back("setpts=PTS+" + formatSeconds(clip.videoFadeOffsetUs) + "/TB");
      if (clip.videoFadeInUs > 0) filters.push_back("fade=t=in:st=0:d=" + formatSeconds(std::min(clip.videoFadeInUs, fadeDurationUs)) + ":alpha=1");
      if (clip.videoFadeOutUs > 0) {
        const auto fade = std::min(clip.videoFadeOutUs, fadeDurationUs);
        filters.push_back("fade=t=out:st=" + formatSeconds(fadeDurationUs - fade) + ":d=" + formatSeconds(fade) + ":alpha=1");
      }
      if (offsetFade) filters.push_back("setpts=PTS-" + formatSeconds(clip.videoFadeOffsetUs) + "/TB");
    }
    filters.push_back("setpts=PTS+" + formatSeconds(clip.startUs) + "/TB");
    return join(filters, ",") + "[layer" + std::to_string(layerIndex) + "]";
  }

  [[nodiscard]] static std::string videoSegmentFilter(
      int inputIndex,
      int segmentIndex,
      const ExportTimelineClip& clip,
      const ExportJob& job,
      std::int64_t sourceInUs,
      std::int64_t sourceDurationUs,
      std::int64_t durationUs,
      bool useCudaDecode) {
    const auto speed = normalizedSpeedFactor(clip);
    std::vector<std::string> filters = {
        "[" + std::to_string(inputIndex) + ":v]trim=start=" + formatSeconds(sourceInUs) + ":duration=" + formatSeconds(sourceDurationUs),
        "setpts=(PTS-STARTPTS)/" + formatDouble(speed),
        "trim=duration=" + formatSeconds(durationUs),
        "setpts=PTS-STARTPTS",
        "fps=" + std::to_string(job.fps),
    };
    if (useCudaDecode) {
      filters.insert(filters.end(), {
                                        "scale_cuda=" + std::to_string(job.width) + ":" + std::to_string(job.height) + ":force_original_aspect_ratio=decrease:force_divisible_by=2",
                                        "hwdownload",
                                        "format=nv12",
                                    });
    } else {
      filters.push_back("scale=" + std::to_string(job.width) + ":" + std::to_string(job.height) + ":force_original_aspect_ratio=decrease:force_divisible_by=2");
    }
    filters.insert(filters.end(), {
                                      "pad=" + std::to_string(job.width) + ":" + std::to_string(job.height) + ":(ow-iw)/2:(oh-ih)/2",
                                      "setsar=1",
                                  });

    appendColorFilters(clip, filters);
    appendEffectFilters(clip, filters);

    const auto hasTransform = clip.transformEnabled &&
                              (std::abs(clip.scale - 1.0) > 0.001 || std::abs(clip.positionX) > 0.001 ||
                               std::abs(clip.positionY) > 0.001 || std::abs(clip.rotation) > 0.001 ||
                               std::abs(clip.opacity - 1.0) > 0.001);
    if (hasTransform) {
      const auto scale = std::clamp(clip.scale, 0.1, 4.0);
      const auto opacity = std::clamp(clip.opacity, 0.0, 1.0);
      if (std::abs(scale - 1.0) > 0.001) {
        filters.push_back("scale=round(iw*" + formatDouble(scale) + "/2)*2:round(ih*" + formatDouble(scale) + "/2)*2");
      }
      if (std::abs(clip.rotation) > 0.001) {
        filters.push_back("rotate=" + formatDouble(clip.rotation * 3.14159265358979323846 / 180.0) + ":ow=rotw(iw):oh=roth(ih):c=black@0");
      }
      if (opacity < 0.999) {
        filters.push_back("colorchannelmixer=aa=" + formatDouble(opacity));
      }
      filters.push_back("format=rgba[fg" + std::to_string(segmentIndex) + "]");
      return join(filters, ",") + ";color=c=black:s=" + std::to_string(job.width) + "x" + std::to_string(job.height) + ":r=" + std::to_string(job.fps) +
             ":d=" + formatSeconds(durationUs) + "[base" + std::to_string(segmentIndex) + "];[base" + std::to_string(segmentIndex) + "][fg" +
             std::to_string(segmentIndex) + "]overlay=x=(W-w)/2+" + formatDouble(clip.positionX) + ":y=(H-h)/2+" + formatDouble(clip.positionY) +
             ":format=auto,format=yuv420p[v" + std::to_string(segmentIndex) + "]";
    }

    filters.push_back("format=yuv420p");
    return join(filters, ",") + "[v" + std::to_string(segmentIndex) + "]";
  }

  static void appendColorFilters(const ExportTimelineClip& clip, std::vector<std::string>& filters) {
    const auto brightness = std::clamp(clip.brightness / 100.0, -1.0, 1.0);
    const auto contrast = std::max(0.0, 1.0 + clip.contrast / 100.0);
    const auto saturation = std::max(0.0, clip.saturation);
    if (std::abs(brightness) > 0.001 || std::abs(contrast - 1.0) > 0.001 || std::abs(saturation - 1.0) > 0.001) {
      filters.push_back("eq=brightness=" + formatDouble(brightness) + ":contrast=" + formatDouble(contrast) + ":saturation=" + formatDouble(saturation));
    }
    if (std::abs(clip.temperature) > 0.001 || std::abs(clip.tint) > 0.001) {
      const auto warmth = std::clamp(clip.temperature / 100.0, -1.0, 1.0);
      const auto tint = std::clamp(clip.tint / 100.0, -1.0, 1.0);
      filters.push_back("colorbalance=rm=" + formatDouble(0.12 * warmth + 0.06 * tint) + ":gm=" + formatDouble(-0.08 * tint) + ":bm=" + formatDouble(-0.12 * warmth + 0.06 * tint));
    }
    appendLutPresetFilters(clip, filters);
  }

  static void appendLutPresetFilters(const ExportTimelineClip& clip, std::vector<std::string>& filters) {
    if (clip.lutId.empty() || clip.lutStrength <= 0) {
      return;
    }
    const auto strength = std::clamp(clip.lutStrength, 0.0, 1.0);
    if (clip.lutId == "warm") {
      filters.push_back("colorbalance=rs=" + formatDouble(0.12 * strength) + ":bs=" + formatDouble(-0.08 * strength));
      filters.push_back("eq=saturation=" + formatDouble(1.0 + 0.18 * strength));
    } else if (clip.lutId == "cool") {
      filters.push_back("colorbalance=bs=" + formatDouble(0.12 * strength) + ":rs=" + formatDouble(-0.06 * strength));
      filters.push_back("eq=saturation=" + formatDouble(1.0 + 0.08 * strength));
    } else if (clip.lutId == "filmic") {
      filters.push_back("curves=all='0/0 0.25/" + formatDouble(0.25 - 0.05 * strength) + " 0.75/" + formatDouble(0.75 + 0.05 * strength) + " 1/1'");
      filters.push_back("eq=saturation=" + formatDouble(1.0 - 0.12 * strength));
    } else if (clip.lutId == "mono") {
      filters.push_back("hue=s=" + formatDouble(1.0 - strength));
      filters.push_back("eq=contrast=" + formatDouble(1.0 + 0.12 * strength));
    }
  }

  static void appendEffectFilters(const ExportTimelineClip& clip, std::vector<std::string>& filters) {
    for (const auto& effect : clip.effects) {
      if (!effect.enabled || effect.amount <= 0) {
        continue;
      }
      const auto amount = std::clamp(effect.amount, 0.0, 100.0);
      if (effect.type == "blur") {
        filters.push_back("gblur=sigma=" + formatDouble(amount / 18.0));
      } else if (effect.type == "sharpen") {
        filters.push_back("unsharp=5:5:" + formatDouble(amount / 40.0) + ":3:3:0");
      } else if (effect.type == "vignette") {
        filters.push_back("vignette=angle=" + formatDouble(0.25 + amount / 140.0));
      } else if (effect.type == "grayscale") {
        filters.push_back("hue=s=" + formatDouble(1.0 - amount / 100.0));
      }
    }
  }

  [[nodiscard]] static std::string audioFilterChain(
      const ExportTimelineClip& clip,
      std::int64_t sourceDurationUs,
      std::int64_t outputDurationUs,
      std::int64_t delayMs,
      const std::string& outputLabel) {
    std::vector<std::string> filters = {
        "atrim=start=0:duration=" + formatSeconds(sourceDurationUs),
        "asetpts=PTS-STARTPTS",
        "aresample=48000",
    };
    appendAtempoFilters(normalizedSpeedFactor(clip), filters);

    if (std::abs(clip.audioGainDb) > 0.001) {
      filters.push_back("volume=" + formatDb(clip.audioGainDb));
    }
    if (clip.audioFadeDurationUs > 0 && (clip.audioFadeInUs > 0 || clip.audioFadeOutUs > 0)) {
      // Evaluate the original fade per sample after speed adjustment. afade's
      // sample counter starts over for each input, so it cannot retain a split.
      std::string envelope = "val(ch)";
      const auto time = "(t+" + formatSeconds(clip.audioFadeOffsetUs) + ")";
      if (clip.audioFadeInUs > 0) envelope += "*min(1,max(0," + time + "/" + formatSeconds(std::min(clip.audioFadeInUs, clip.audioFadeDurationUs)) + "))";
      if (clip.audioFadeOutUs > 0) envelope += "*min(1,max(0,(" + formatSeconds(clip.audioFadeDurationUs) + "-" + time + ")/" + formatSeconds(std::min(clip.audioFadeOutUs, clip.audioFadeDurationUs)) + "))";
      // Fix the layout before aeval: negotiation from mono inputs to the
      // stereo export can otherwise give its evaluator inconsistent planes.
      filters.push_back("aformat=channel_layouts=stereo");
      filters.push_back("aeval='" + envelope + "':c=same");
    } else {
      if (clip.audioFadeInUs > 0) {
        filters.push_back("afade=t=in:st=0:d=" + formatSeconds(std::min(clip.audioFadeInUs, outputDurationUs)));
      }
      if (clip.audioFadeOutUs > 0) {
        const auto fadeDurationUs = std::min(clip.audioFadeOutUs, outputDurationUs);
        filters.push_back("afade=t=out:st=" + formatSeconds(std::max<std::int64_t>(0, outputDurationUs - fadeDurationUs)) + ":d=" + formatSeconds(fadeDurationUs));
      }
    }
    if (clip.audioCleanup) {
      filters.push_back("highpass=f=80");
      filters.push_back("afftdn=nf=-25");
    }
    if (clip.audioNormalize) {
      filters.push_back("loudnorm=I=-16:TP=-1.5:LRA=11");
    }
    if (delayMs > 0) {
      filters.push_back("adelay=" + std::to_string(delayMs) + "|" + std::to_string(delayMs));
      // Delayed silence can precede the first decoded frame after an input
      // seek. Give those samples valid timestamps before atrim/amix.
      filters.push_back("asetpts=N/SR/TB");
    }
    filters.push_back("apad");
    filters.push_back("atrim=duration=" + formatSeconds(outputDurationUs + delayMs * 1000));
    return join(filters, ",") + "[" + outputLabel + "]";
  }

  [[nodiscard]] static std::string finalAudioFilterChain(const ExportJob& job) {
    std::vector<std::string> filters;
    if (job.cleanupAudio) {
      filters.push_back("highpass=f=60");
      filters.push_back("afftdn=nf=-30");
    }
    if (std::abs(job.masterGainDb) > 0.001) {
      filters.push_back("volume=" + formatDb(job.masterGainDb));
    }
    if (job.normalizeAudio) {
      filters.push_back("loudnorm=I=-16:TP=-1.5:LRA=11");
    }
    filters.push_back("apad");
    filters.push_back("atrim=start=" + formatSeconds(job.rangeStartUs) + ":duration=" + formatSeconds(job.durationUs));
    filters.push_back("asetpts=PTS-STARTPTS");
    return join(filters, ",");
  }

  static void appendAtempoFilters(double speed, std::vector<std::string>& filters) {
    auto remaining = std::clamp(speed, 0.25, 4.0);
    while (remaining < 0.5) {
      filters.push_back("atempo=0.5000");
      remaining /= 0.5;
    }
    while (remaining > 2.0) {
      filters.push_back("atempo=2.0000");
      remaining /= 2.0;
    }
    if (std::abs(remaining - 1.0) > 0.001) {
      filters.push_back("atempo=" + formatDouble(remaining));
    }
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

  [[nodiscard]] static std::filesystem::path titleTextPath(const std::string& jobId, std::size_t index) {
    return std::filesystem::temp_directory_path() / (jobId + "_title_" + std::to_string(index) + ".txt");
  }

  [[nodiscard]] static std::filesystem::path filterGraphPath(const std::string& jobId, bool useCudaDecode) {
    return std::filesystem::temp_directory_path() / (jobId + (useCudaDecode ? "_cuda.filter" : "_cpu.filter"));
  }

  static std::string titleFilterChain(const ExportJob& job) {
    std::vector<std::string> filters;
    for (std::size_t index = 0; index < job.timeline.titles.size(); ++index) {
      const auto& title = job.timeline.titles[index];
      if (title.startUs >= job.rangeStartUs + job.durationUs || title.startUs + title.durationUs <= job.rangeStartUs) continue;
      std::string path;
      const auto textPath = job.resourceDirectory.empty() ? titleTextPath(job.id, index) : std::filesystem::u8path(job.resourceDirectory) / ("title_" + std::to_string(index) + ".txt");
      for (const auto ch : textPath.generic_string()) {
        if (ch == ':') path += "\\:";
        else if (ch == '\'') path += "'\\''";
        else path += ch;
      }
      filters.push_back("drawtext=font=Arial:textfile='" + path + "':expansion=none:fontsize=" + std::to_string(title.fontSize) + ":fontcolor=0x" + title.color.substr(1) + ":x=(w-tw)*" + formatDouble(title.positionX / 100.0) + ":y=(h-th)*" + formatDouble(title.positionY / 100.0) + ":box=" + (title.background ? "1" : "0") + ":boxcolor=black@0.55:boxborderw=12:enable='gte(t," + formatSeconds(title.startUs) + ")*lt(t," + formatSeconds(title.startUs + title.durationUs) + ")'");
    }
    return filters.empty() ? "null" : join(filters, ",");
  }

  void runExportProcess(
      const std::string& jobId,
      const std::string& command,
      const std::string& compatibilityCommand,
      const std::string& outputPath) {
    auto exitCode = runCommandCancellable(command);

    if (exitCode != 0 && exitCode != -22 && !compatibilityCommand.empty() && !cancelRequested_) {
      {
        std::lock_guard lock(mutex_);
        if (!activeJob_ || activeJob_->id != jobId || activeJob_->cancelled) {
          return;
        }
        activeJob_->logs.push_back("Hardware pipeline failed; retrying with compatibility decoding");
        activeJob_->progress = 0.0;
        activeJob_->processedFrames = 0;
        activeJob_->encodingFps = 0.0;
        activeJob_->speed = 0.0;
        activeJob_->etaSeconds = 0.0;
        lastLoggedProgressPercent_ = -1;
      }

      std::error_code ignored;
      std::filesystem::remove(outputPath, ignored);
      std::filesystem::remove(activeProgressPath_, ignored);
      exitCode = runCommandCancellable(compatibilityCommand);
    }

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
      if (exitCode == 69) {
        activeJob_->logs.push_back("FFmpeg could not decode one or more source clips");
      } else if (exitCode == -22) {
        activeJob_->logs.push_back("FFmpeg rejected the encoder configuration");
      } else if (exitCode == -542398533) {
        activeJob_->logs.push_back("FFmpeg reported an external decoder or NVENC failure");
      }
      activeJob_->logs.push_back("FFmpeg export failed with exit code " + std::to_string(exitCode));
    }
    activeJob_->finishedAt = std::chrono::steady_clock::now();
    for (const bool cuda : {true, false}) { std::error_code ignored; std::filesystem::remove(filterGraphPath(jobId, cuda), ignored); }
    for (std::size_t index = 0; index < activeJob_->timeline.titles.size(); ++index) {
      std::error_code ignored;
      std::filesystem::remove(titleTextPath(jobId, index), ignored);
    }
  }

  int runCommandCancellable(const std::string& command) {
#ifdef _WIN32
    auto diagnosticPath = activeProgressPath_;
    diagnosticPath += ".stderr.log";
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE diagnosticFile = CreateFileW(diagnosticPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    HANDLE nullFile = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    if (diagnosticFile == INVALID_HANDLE_VALUE || nullFile == INVALID_HANDLE_VALUE) {
      const auto error = GetLastError();
      if (diagnosticFile != INVALID_HANDLE_VALUE) CloseHandle(diagnosticFile);
      if (nullFile != INVALID_HANDLE_VALUE) CloseHandle(nullFile);
      return static_cast<int>(error);
    }
    STARTUPINFOW startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    startupInfo.dwFlags = STARTF_USESTDHANDLES;
    startupInfo.hStdInput = nullFile;
    startupInfo.hStdOutput = nullFile;
    startupInfo.hStdError = diagnosticFile;
    PROCESS_INFORMATION processInfo{};
    const auto length = MultiByteToWideChar(CP_UTF8, 0, command.data(), static_cast<int>(command.size()), nullptr, 0);
    std::wstring commandLine(length, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, command.data(), static_cast<int>(command.size()), commandLine.data(), length);
    const auto started = CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startupInfo, &processInfo);
    const auto startError = GetLastError();
    CloseHandle(diagnosticFile);
    CloseHandle(nullFile);
    if (!started) {
      std::lock_guard lock(mutex_);
      if (activeJob_) activeJob_->logs.push_back("Could not start FFmpeg (Windows error " + std::to_string(startError) + ")");
      return static_cast<int>(startError);
    }

    {
      std::lock_guard lock(mutex_);
      activeProcess_ = processInfo.hProcess;
    }
    CloseHandle(processInfo.hThread);

    DWORD waitResult = WAIT_TIMEOUT;
    while ((waitResult = WaitForSingleObject(processInfo.hProcess, 200)) == WAIT_TIMEOUT) {
      {
        std::lock_guard lock(mutex_);
        updateProgressFromFile();
      }
      if (cancelRequested_) {
        TerminateProcess(processInfo.hProcess, 1);
      }
    }

    DWORD exitCode = 1;
    GetExitCodeProcess(processInfo.hProcess, &exitCode);
    {
      std::lock_guard lock(mutex_);
      if (activeProcess_ == processInfo.hProcess) {
        activeProcess_ = nullptr;
      }
    }
    CloseHandle(processInfo.hProcess);
    if (exitCode != 0 && !cancelRequested_) {
      // Keep a bounded tail of FFmpeg's actual diagnostics in the export panel.
      std::ifstream diagnostics(diagnosticPath, std::ios::binary);
      diagnostics.seekg(0, std::ios::end);
      const auto size = diagnostics.tellg();
      if (size > 0) {
        diagnostics.seekg(std::max<std::streamoff>(0, static_cast<std::streamoff>(size) - 12'000));
        std::string tail((std::istreambuf_iterator<char>(diagnostics)), std::istreambuf_iterator<char>());
        std::lock_guard lock(mutex_);
        if (activeJob_) activeJob_->logs.push_back("FFmpeg diagnostics:\n" + tail);
      }
    }
    std::error_code ignored;
    std::filesystem::remove(diagnosticPath, ignored);
    return static_cast<int>(exitCode);
#else
    return std::system(command.c_str());
#endif
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
    std::int64_t processedFrames = activeJob_->processedFrames;
    double encodingFps = activeJob_->encodingFps;
    double speed = activeJob_->speed;
    std::string progressStatus;
    while (std::getline(stream, line)) {
      const auto separator = line.find('=');
      if (separator == std::string::npos) {
        continue;
      }
      const auto key = line.substr(0, separator);
      const auto value = line.substr(separator + 1);
      if (key == "out_time_us" || key == "out_time_ms") {
        try {
          outTimeUs = std::stoll(value);
        } catch (...) {
          outTimeUs = 0;
        }
      } else if (key == "frame") {
        try {
          processedFrames = std::stoll(value);
        } catch (...) {
        }
      } else if (key == "fps") {
        try {
          encodingFps = std::stod(value);
        } catch (...) {
        }
      } else if (key == "speed") {
        try {
          speed = std::stod(value);
        } catch (...) {
        }
      } else if (key == "progress") {
        progressStatus = value;
      }
    }

    activeJob_->processedFrames = processedFrames;
    activeJob_->encodingFps = std::max(0.0, encodingFps);
    activeJob_->speed = std::max(0.0, speed);
    activeJob_->elapsedSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - activeJob_->startedAt).count();

    if (outTimeUs > 0 && activeJob_->durationUs > 0) {
      activeJob_->progress = std::clamp(static_cast<double>(outTimeUs) / static_cast<double>(activeJob_->durationUs), 0.0, 0.99);
      const auto remainingUs = std::max<std::int64_t>(0, activeJob_->durationUs - outTimeUs);
      activeJob_->etaSeconds = activeJob_->speed > 0.0 ? remainingUs / 1'000'000.0 / activeJob_->speed : 0.0;
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

  [[nodiscard]] static ExportRequestTimeline timelineFromJson(const nlohmann::json& params) {
    ExportRequestTimeline timeline;
    if (params.contains("mediaAssets") && params.at("mediaAssets").is_array()) {
      for (const auto& item : params.at("mediaAssets")) {
        ExportMediaAsset media;
        media.id = item.value("id", std::string{});
        media.path = item.value("path", std::string{});
        media.kind = item.value("kind", std::string{"video"});
        if (item.contains("metadata") && item.at("metadata").is_object()) {
          media.hasAudio = item.at("metadata").value("hasAudio", media.kind == "audio");
          media.isStillImage = item.at("metadata").value("isStillImage", false);
        } else {
          media.hasAudio = media.kind == "audio";
        }
        if (!media.id.empty() && !media.path.empty()) {
          timeline.media.push_back(media);
        }
      }
    }

    if (!params.contains("timeline") || !params.at("timeline").is_object()) {
      return timeline;
    }

    const auto& sourceTimeline = params.at("timeline");
    timeline.titles = sourceTimeline.value("titles", std::vector<TitleOverlay>{});
    if (!sourceTimeline.contains("tracks") || !sourceTimeline.at("tracks").is_array()) {
      return timeline;
    }

    for (const auto& track : sourceTimeline.at("tracks")) {
      if (!track.contains("clips") || !track.at("clips").is_array()) {
        continue;
      }
      for (const auto& item : track.at("clips")) {
        ExportTimelineClip clip;
        clip.mediaId = item.value("mediaId", std::string{});
        clip.trackId = track.value("id", item.value("trackId", std::string{}));
        clip.trackKind = track.value("kind", std::string{"video"});
        clip.trackIndex = track.value("index", 0);
        clip.trackVisible = track.value("visible", true);
        clip.trackMuted = track.value("muted", false);
        clip.startUs = item.value("startUs", 0LL);
        clip.inUs = item.value("inUs", 0LL);
        clip.outUs = item.value("outUs", clip.inUs);
        clip.speedPercent = normalizeSpeedPercent(item.value("speedPercent", 100.0));
        if (item.contains("audio") && item.at("audio").is_object()) {
          const auto& audio = item.at("audio");
          clip.audioGainDb = audio.value("gainDb", 0.0);
          clip.audioMuted = audio.value("muted", false);
          clip.audioFadeInUs = audio.value("fadeInUs", 0LL);
          clip.audioFadeOutUs = audio.value("fadeOutUs", 0LL);
          clip.audioFadeOffsetUs = audio.value("fadeOffsetUs", 0LL);
          clip.audioFadeDurationUs = audio.value("fadeDurationUs", 0LL);
          clip.audioNormalize = audio.value("normalize", false);
          clip.audioCleanup = audio.value("cleanup", false);
          clip.audioStreamIndex = audio.value("streamIndex", 0);
        }
        if (item.contains("color") && item.at("color").is_object()) {
          const auto& color = item.at("color");
          clip.brightness = color.value("brightness", 0.0);
          clip.contrast = color.value("contrast", 0.0);
          clip.saturation = color.value("saturation", 1.0);
          clip.temperature = color.value("temperature", 0.0);
          clip.tint = color.value("tint", 0.0);
        }
        if (item.contains("lut") && item.at("lut").is_object()) {
          const auto& lut = item.at("lut");
          clip.lutId = lut.value("lutId", std::string{});
          clip.lutStrength = lut.value("strength", 1.0);
        }
        if (item.contains("transform") && item.at("transform").is_object()) {
          const auto& transform = item.at("transform");
          clip.transformEnabled = transform.value("enabled", true);
          clip.scale = transform.value("scale", 1.0);
          clip.positionX = transform.value("positionX", 0.0);
          clip.positionY = transform.value("positionY", 0.0);
          clip.rotation = transform.value("rotation", 0.0);
          clip.opacity = transform.value("opacity", 1.0);
          clip.videoFadeInUs = transform.value("fadeInUs", 0LL);
          clip.videoFadeOutUs = transform.value("fadeOutUs", 0LL);
          clip.videoFadeOffsetUs = transform.value("fadeOffsetUs", 0LL);
          clip.videoFadeDurationUs = transform.value("fadeDurationUs", 0LL);
        }
        if (item.contains("effects") && item.at("effects").is_array()) {
          for (const auto& effectItem : item.at("effects")) {
            ExportClipEffect effect;
            effect.id = effectItem.value("id", std::string{});
            effect.type = effectItem.value("type", std::string{});
            effect.label = effectItem.value("label", effect.type);
            effect.enabled = effectItem.value("enabled", false);
            effect.amount = effectItem.value("amount", 0.0);
            if (!effect.type.empty()) {
              clip.effects.push_back(effect);
            }
          }
        }
        if (!clip.mediaId.empty()) {
          timeline.clips.push_back(clip);
        }
      }
    }
    return timeline;
  }

  [[nodiscard]] static const ExportMediaAsset* findMedia(const std::vector<ExportMediaAsset>& media, const std::string& mediaId) {
    const auto item = std::find_if(media.begin(), media.end(), [&](const ExportMediaAsset& asset) {
      return asset.id == mediaId;
    });
    return item == media.end() ? nullptr : &(*item);
  }

  [[nodiscard]] static std::int64_t visibleVideoDurationUs(const ExportRequestTimeline& timeline) {
    std::int64_t durationUs = 0;
    for (const auto& title : timeline.titles) durationUs = std::max(durationUs, title.startUs + title.durationUs);
    for (const auto& clip : timeline.clips) {
      const auto* media = findMedia(timeline.media, clip.mediaId);
      if (!media || media->kind != "video" || clip.trackKind != "video" || !clip.trackVisible || clip.outUs <= clip.inUs) {
        continue;
      }
      durationUs = std::max(durationUs, clip.startUs + clipDisplayDurationUs(clip));
    }
    for (const auto& clip : timeline.clips) {
      const auto* media = findMedia(timeline.media, clip.mediaId);
      if (media && media->hasAudio && !clip.audioMuted && !clip.trackMuted && (clip.trackKind != "video" || clip.trackVisible)) durationUs = std::max(durationUs, clip.startUs + clipDisplayDurationUs(clip));
    }
    return durationUs;
  }

  [[nodiscard]] static double normalizeSpeedPercent(double value) {
    if (!std::isfinite(value)) {
      return 100.0;
    }
    return std::clamp(value, 25.0, 400.0);
  }

  [[nodiscard]] static double normalizedSpeedFactor(const ExportTimelineClip& clip) {
    return normalizeSpeedPercent(clip.speedPercent) / 100.0;
  }

  [[nodiscard]] static std::int64_t clipSourceDurationUs(const ExportTimelineClip& clip) {
    return std::max<std::int64_t>(0, clip.outUs - clip.inUs);
  }

  [[nodiscard]] static std::int64_t clipDisplayDurationUs(const ExportTimelineClip& clip) {
    const auto sourceDurationUs = clipSourceDurationUs(clip);
    if (sourceDurationUs <= 0) {
      return 0;
    }
    return std::max<std::int64_t>(1, static_cast<std::int64_t>(std::llround(static_cast<double>(sourceDurationUs) / normalizedSpeedFactor(clip))));
  }

  [[nodiscard]] static bool hasRenderableTimeline(const ExportJob& job) {
    return !job.timeline.titles.empty() || countRenderableVideoClips(job) > 0 || countRenderableAudioClips(job) > 0;
  }

  [[nodiscard]] static std::size_t countRenderableVideoClips(const ExportJob& job) {
    return static_cast<std::size_t>(std::count_if(job.timeline.clips.begin(), job.timeline.clips.end(), [&](const ExportTimelineClip& clip) {
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      return media && media->kind == "video" && clip.trackKind == "video" && clip.trackVisible && clip.outUs > clip.inUs;
    }));
  }

  [[nodiscard]] static std::size_t countRenderableAudioClips(const ExportJob& job) {
    return static_cast<std::size_t>(std::count_if(job.timeline.clips.begin(), job.timeline.clips.end(), [&](const ExportTimelineClip& clip) {
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      if (!media || !media->hasAudio || clip.audioMuted || clip.trackMuted || clip.outUs <= clip.inUs) {
        return false;
      }
      return clip.trackKind != "video" || clip.trackVisible;
    }));
  }

  [[nodiscard]] static std::vector<ExportTimelineSegment> buildTimelineSegments(const ExportJob& job) {
    std::vector<const ExportTimelineClip*> clips;
    for (const auto& clip : job.timeline.clips) {
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      if (media && media->kind == "video" && clip.trackKind == "video" && clip.trackVisible && clip.outUs > clip.inUs) {
        clips.push_back(&clip);
      }
    }

    std::sort(clips.begin(), clips.end(), [](const ExportTimelineClip* left, const ExportTimelineClip* right) {
      if (left->startUs != right->startUs) {
        return left->startUs < right->startUs;
      }
      return left->trackIndex < right->trackIndex;
    });

    std::vector<ExportTimelineSegment> segments;
    std::int64_t cursorUs = 0;
    for (const auto* clip : clips) {
      const auto displayDurationUs = clipDisplayDurationUs(*clip);
      const auto clipEndUs = clip->startUs + displayDurationUs;
      if (clipEndUs <= cursorUs || cursorUs >= job.durationUs) {
        continue;
      }
      if (clip->startUs > cursorUs) {
        segments.push_back({nullptr, cursorUs, 0, 0, std::min(clip->startUs, job.durationUs) - cursorUs, true});
        cursorUs = std::min(clip->startUs, job.durationUs);
      }
      const auto segmentStartUs = std::max(cursorUs, clip->startUs);
      const auto segmentEndUs = std::min(clipEndUs, job.durationUs);
      if (segmentEndUs > segmentStartUs) {
        const auto outputDurationUs = segmentEndUs - segmentStartUs;
        const auto speed = normalizedSpeedFactor(*clip);
        const auto sourceOffsetUs = static_cast<std::int64_t>(std::llround(static_cast<double>(segmentStartUs - clip->startUs) * speed));
        const auto sourceInUs = std::min<std::int64_t>(clip->outUs, clip->inUs + sourceOffsetUs);
        const auto availableSourceUs = std::max<std::int64_t>(0, clip->outUs - sourceInUs);
        const auto sourceDurationUs = std::min<std::int64_t>(
            availableSourceUs,
            std::max<std::int64_t>(1, static_cast<std::int64_t>(std::llround(static_cast<double>(outputDurationUs) * speed))));
        segments.push_back({clip, segmentStartUs, sourceInUs, sourceDurationUs, outputDurationUs, false});
        cursorUs = segmentEndUs;
      }
    }

    if (cursorUs < job.durationUs) {
      segments.push_back({nullptr, cursorUs, 0, 0, job.durationUs - cursorUs, true});
    }
    if (segments.empty()) {
      segments.push_back({nullptr, 0, 0, 0, job.durationUs, true});
    }
    return segments;
  }

  [[nodiscard]] static std::vector<const ExportTimelineClip*> collectAudioClips(const ExportJob& job) {
    std::vector<const ExportTimelineClip*> clips;
    for (const auto& clip : job.timeline.clips) {
      const auto* media = findMedia(job.timeline.media, clip.mediaId);
      if (!media || !media->hasAudio || clip.audioMuted || clip.trackMuted || clip.outUs <= clip.inUs) {
        continue;
      }
      if (clip.trackKind == "video" && !clip.trackVisible) {
        continue;
      }
      clips.push_back(&clip);
    }

    std::sort(clips.begin(), clips.end(), [](const ExportTimelineClip* left, const ExportTimelineClip* right) {
      if (left->startUs != right->startUs) {
        return left->startUs < right->startUs;
      }
      return left->trackIndex < right->trackIndex;
    });
    return clips;
  }

  [[nodiscard]] static double qualityMultiplier(const std::string& quality) {
    if (quality == "trash") {
      return 0.12;
    }
    if (quality == "low") {
      return 0.28;
    }
    if (quality == "high") {
      return 0.85;
    }
    if (quality == "pro_max") {
      return 1.15;
    }
    return 0.55;
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
    if (quality == "trash") {
      return "p4";
    }
    if (quality == "low" || quality == "medium") {
      return "p5";
    }
    if (quality == "high") {
      return "p6";
    }
    if (quality == "pro_max") {
      return "p7";
    }
    return "p5";
  }

  [[nodiscard]] static std::string presetForJob(const ExportJob& job) {
    return job.encoderOptions.enabled ? job.encoderOptions.preset : presetForQuality(job.quality);
  }

  [[nodiscard]] static int targetQualityFor(const ExportJob& job) {
    if (job.codec == "av1_nvenc") {
      if (job.quality == "trash") {
        return 52;
      }
      if (job.quality == "low") {
        return 42;
      }
      if (job.quality == "high") {
        return 28;
      }
      if (job.quality == "pro_max") {
        return 24;
      }
      return 34;
    }
    if (job.codec == "hevc_nvenc") {
      if (job.quality == "trash") {
        return 44;
      }
      if (job.quality == "low") {
        return 35;
      }
      if (job.quality == "high") {
        return 23;
      }
      if (job.quality == "pro_max") {
        return 19;
      }
      return 28;
    }
    if (job.quality == "trash") {
      return 43;
    }
    if (job.quality == "low") {
      return 34;
    }
    if (job.quality == "high") {
      return 23;
    }
    if (job.quality == "pro_max") {
      return 20;
    }
    return 28;
  }

  [[nodiscard]] static int lookaheadDepthFor(const std::string& quality) {
    if (quality == "trash") {
      return 0;
    }
    if (quality == "low") {
      return 12;
    }
    if (quality == "high") {
      return 20;
    }
    if (quality == "pro_max") {
      return 24;
    }
    return 16;
  }

  [[nodiscard]] static double peakBitrateMultiplierFor(const std::string& quality) {
    if (quality == "trash") {
      return 1.0;
    }
    if (quality == "low") {
      return 1.25;
    }
    if (quality == "medium") {
      return 1.5;
    }
    if (quality == "high") {
      return 1.75;
    }
    if (quality == "pro_max") {
      return 2.0;
    }
    return 1.5;
  }

  static void appendNvencOptions(const ExportJob& job, std::vector<std::string>& args) {
    const auto& custom = job.encoderOptions;
    const auto lookaheadDepth = custom.enabled ? custom.lookaheadDepth : lookaheadDepthFor(job.quality);
    const auto maxBitrateMbps = custom.enabled
                                    ? custom.maxBitrateMbps
                                    : std::max(2, static_cast<int>(std::ceil(job.bitrateMbps * peakBitrateMultiplierFor(job.quality))));
    const auto bufferSizeMbps = std::max(4, maxBitrateMbps * 2);
    const bool ultraHighQuality = job.codec != "h264_nvenc" && custom.enabled && custom.tune == "uhq";
    const auto cq = custom.enabled ? custom.cq : targetQualityFor(job);
    const auto spatialAq = !custom.enabled || custom.spatialAq;
    const auto temporalAq = custom.enabled ? custom.temporalAq : job.quality != "trash";
    const auto aqStrength = custom.enabled ? custom.aqStrength : (job.quality == "trash" ? 6 : (job.quality == "low" ? 7 : 8));
    const auto bFrames = custom.enabled ? custom.bFrames : 3;
    const auto bRefMode = custom.enabled ? custom.bRefMode : std::string{"middle"};
    const auto referenceFrames = custom.enabled ? custom.referenceFrames : 4;

    args.insert(args.end(), {
                                "-tune",
                                ultraHighQuality ? "uhq" : "hq",
                                "-rc",
                                "vbr",
                                "-b:v",
                                "0",
                                "-cq",
                                std::to_string(cq),
                                "-maxrate",
                                std::to_string(maxBitrateMbps) + "M",
                                "-bufsize",
                                std::to_string(bufferSizeMbps) + "M",
                                "-spatial-aq",
                                spatialAq ? "1" : "0",
                                "-temporal-aq",
                                temporalAq ? "1" : "0",
                                "-aq-strength",
                                std::to_string(aqStrength),
                                "-g",
                                std::to_string(std::max(1, job.fps * 2)),
                                "-threads",
                                "0",
                            });

    if (lookaheadDepth > 0 && !ultraHighQuality) {
      args.insert(args.end(), {"-rc-lookahead", std::to_string(lookaheadDepth)});
      // Extended lookahead levels depend on codec and GPU capabilities. H.264
      // only supports level zero; let NVENC use its compatible default otherwise.
      if (custom.enabled && custom.lookaheadLevel > 0 && job.codec != "h264_nvenc") {
        args.insert(args.end(), {"-lookahead_level", std::to_string(custom.lookaheadLevel)});
      }
    }

    const auto multipass = custom.enabled
                               ? custom.multipass
                               : (job.quality == "trash" ? std::string{"disabled"}
                                  : job.quality == "pro_max" ? std::string{"fullres"}
                                                              : std::string{"qres"});
    if (multipass != "disabled") {
      args.insert(args.end(), {"-multipass", multipass});
    }

    if (job.codec == "h264_nvenc") {
      args.insert(args.end(), {"-profile", "high", "-coder", "cabac"});
      if (custom.enabled) {
        args.insert(args.end(), {
                                    "-bf",
                                    std::to_string(bFrames),
                                    "-b_ref_mode",
                                    bFrames > 0 ? bRefMode : "disabled",
                                    "-refs",
                                    std::to_string(referenceFrames),
                                });
      }
    } else {
      // HEVC and AV1 gain coding efficiency when NVENC internally promotes
      // 8-bit input to a 10-bit encode. Disabling split encoding also avoids
      // trading compression quality for multi-engine throughput at 4K+.
      const auto highBitDepth = custom.enabled ? custom.highBitDepth : job.colorMode == "HDR";
      const auto splitEncodeMode = custom.enabled ? custom.splitEncodeMode
                                                  : (job.quality == "pro_max" ? std::string{"disabled"} : std::string{"auto"});
      args.insert(args.end(), {
                                  "-highbitdepth",
                                  highBitDepth ? "1" : "0",
                                  "-split_encode_mode",
                                  splitEncodeMode,
                              });
      if (job.codec == "hevc_nvenc" && custom.enabled) {
        args.insert(args.end(), {
                                    "-bf",
                                    std::to_string(bFrames),
                                    "-b_ref_mode",
                                    bFrames > 0 ? bRefMode : "disabled",
                                    "-refs",
                                    std::to_string(referenceFrames),
                                });
      } else if (custom.enabled && !ultraHighQuality && bFrames > 0 && lookaheadDepth == 0 && multipass == "disabled") {
        // AV1 hierarchical B references require lookahead and multipass to be
        // disabled. Otherwise the selected preset owns the reference layout.
        args.insert(args.end(), {
                                    "-bf",
                                    std::to_string(bFrames),
                                    "-b_ref_mode",
                                    bRefMode,
                                    "-refs",
                                    std::to_string(referenceFrames),
                                });
      }
    }
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

  [[nodiscard]] static std::string formatDb(double gainDb) {
    std::ostringstream stream;
    stream.setf(std::ios::fixed);
    stream.precision(2);
    stream << gainDb << "dB";
    return stream.str();
  }

  [[nodiscard]] static std::string formatDouble(double value) {
    std::ostringstream stream;
    stream.setf(std::ios::fixed);
    stream.precision(4);
    stream << value;
    return stream.str();
  }

  [[nodiscard]] static std::string lower(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
      return static_cast<char>(std::tolower(character));
    });
    return value;
  }

  [[nodiscard]] static std::string quoteIfNeeded(const std::string& value) {
    if (value.find_first_of(" \t<>|&()^") == std::string::npos) {
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
#ifdef _WIN32
  HANDLE activeProcess_ = nullptr;
#endif
};

}  // namespace ai_editor
