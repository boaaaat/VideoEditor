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
    job.codec = request.codec;
    job.container = request.container;
    job.quality = request.quality;
    job.bitrateMbps = request.bitrateMbps > 0 ? request.bitrateMbps : calculateBitrateMbps(request);
    job.audioEnabled = request.audioEnabled;
    job.colorMode = request.colorMode;
    job.masterGainDb = request.masterGainDb;
    job.normalizeAudio = request.normalizeAudio;
    job.cleanupAudio = request.cleanupAudio;
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
    const auto progressPath = progressPathFor(job.id);
    std::error_code ignored;
    std::filesystem::remove(progressPath, ignored);
    job.ffmpegCommand = buildFfmpegCommand(job, ffmpeg.path, progressPath.string(), request.overwrite);
    job.logs.push_back("Export started");
    job.logs.push_back("Render duration: " + formatSeconds(job.durationUs));
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
    request.timeline = timelineFromJson(params);
    const auto videoDurationUs = visibleVideoDurationUs(request.timeline);
    if (videoDurationUs > 0 && (request.durationUs <= 0 || request.durationUs > videoDurationUs)) {
      request.durationUs = videoDurationUs;
    }
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
    return buildFfmpegCommand(job, "ffmpeg", "", true);
  }

 private:
  [[nodiscard]] static std::string buildFfmpegCommand(const ExportJob& job, const std::string& ffmpegPath, const std::string& progressPath, bool overwrite) {
    if (hasRenderableTimeline(job)) {
      return buildTimelineFfmpegCommand(job, ffmpegPath, progressPath, overwrite);
    }

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

  [[nodiscard]] static std::string buildTimelineFfmpegCommand(const ExportJob& job, const std::string& ffmpegPath, const std::string& progressPath, bool overwrite) {
    const auto segments = buildTimelineSegments(job);
    const auto audioClips = collectAudioClips(job);
    std::vector<std::string> args = {
        ffmpegPath.empty() ? "ffmpeg" : ffmpegPath,
        "-hide_banner",
        overwrite ? "-y" : "-n",
    };
    std::vector<std::string> filters;
    std::vector<std::string> concatInputs;
    int inputIndex = 0;
    int segmentIndex = 0;

    for (const auto& segment : segments) {
      const auto durationSeconds = formatSeconds(segment.durationUs);
      if (segment.gap || !segment.clip) {
        args.insert(args.end(), {"-f", "lavfi", "-t", durationSeconds, "-i",
                                 "color=c=black:s=" + std::to_string(job.width) + "x" + std::to_string(job.height) + ":r=" + std::to_string(job.fps)});
        filters.push_back("[" + std::to_string(inputIndex) + ":v]setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v" + std::to_string(segmentIndex) + "]");
        inputIndex += 1;
      } else {
        const auto* media = findMedia(job.timeline.media, segment.clip->mediaId);
        args.insert(args.end(), {"-i", media ? media->path : std::string{}});
        filters.push_back(videoSegmentFilter(inputIndex, segmentIndex, *segment.clip, job, segment.sourceInUs, segment.sourceDurationUs, segment.durationUs));
        inputIndex += 1;
      }

      concatInputs.push_back("[v" + std::to_string(segmentIndex) + "]");
      segmentIndex += 1;
    }

    filters.push_back(join(concatInputs, "") + "concat=n=" + std::to_string(segments.size()) + ":v=1:a=0[outv]");

    if (job.audioEnabled) {
      appendAudioMixGraph(job, audioClips, args, filters, inputIndex);
    }

    args.insert(args.end(), {"-filter_complex", join(filters, ";"), "-map", "[outv]"});
    if (job.audioEnabled) {
      args.insert(args.end(), {"-map", "[outa]"});
    }

    args.insert(args.end(), {
        "-t",
        formatSeconds(job.durationUs),
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
      args.insert(args.end(), {"-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2"});
    } else {
      args.push_back("-an");
    }

    if (!progressPath.empty()) {
      args.insert(args.end(), {"-progress", progressPath, "-nostats"});
    }

    args.push_back(job.outputPath);
    return joinQuoted(args);
  }

  static void appendAudioMixGraph(
      const ExportJob& job,
      const std::vector<const ExportTimelineClip*>& clips,
      std::vector<std::string>& args,
      std::vector<std::string>& filters,
      int& inputIndex) {
    if (clips.empty()) {
      args.insert(args.end(), {"-f", "lavfi", "-t", formatSeconds(job.durationUs), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"});
      filters.push_back("[" + std::to_string(inputIndex) + ":a]asetpts=PTS-STARTPTS[outa]");
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
      args.insert(args.end(), {"-i", media->path});
      filters.push_back("[" + std::to_string(inputIndex) + ":a:" + std::to_string(std::max(0, clip->audioStreamIndex)) + "]" + audioFilterChain(*clip, sourceDurationUs, durationUs, delayMs, label));
      audioInputs.push_back("[" + label + "]");
      inputIndex += 1;
    }

    if (audioInputs.empty()) {
      args.insert(args.end(), {"-f", "lavfi", "-t", formatSeconds(job.durationUs), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"});
      filters.push_back("[" + std::to_string(inputIndex) + ":a]asetpts=PTS-STARTPTS[outa]");
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

  [[nodiscard]] static std::string videoSegmentFilter(
      int inputIndex,
      int segmentIndex,
      const ExportTimelineClip& clip,
      const ExportJob& job,
      std::int64_t sourceInUs,
      std::int64_t sourceDurationUs,
      std::int64_t durationUs) {
    const auto speed = normalizedSpeedFactor(clip);
    std::vector<std::string> filters = {
        "[" + std::to_string(inputIndex) + ":v]trim=start=" + formatSeconds(sourceInUs) + ":duration=" + formatSeconds(sourceDurationUs),
        "setpts=(PTS-STARTPTS)/" + formatDouble(speed),
        "fps=" + std::to_string(job.fps),
        "scale=" + std::to_string(job.width) + ":" + std::to_string(job.height) + ":force_original_aspect_ratio=decrease",
        "pad=" + std::to_string(job.width) + ":" + std::to_string(job.height) + ":(ow-iw)/2:(oh-ih)/2",
        "setsar=1",
        "format=rgba",
    };

    appendColorFilters(clip, filters);
    appendEffectFilters(clip, filters);

    if (clip.transformEnabled) {
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
      filters.push_back("hue=h=" + formatDouble((clip.tint + clip.temperature * 0.35) * 3.14159265358979323846 / 180.0));
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
      filters.push_back("curves=preset=medium_contrast");
      filters.push_back("eq=saturation=" + formatDouble(1.0 - 0.12 * strength));
    } else if (clip.lutId == "mono") {
      filters.push_back("hue=s=0");
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
        "atrim=start=" + formatSeconds(clip.inUs) + ":duration=" + formatSeconds(sourceDurationUs),
        "asetpts=PTS-STARTPTS",
        "aresample=48000",
    };
    appendAtempoFilters(normalizedSpeedFactor(clip), filters);

    if (std::abs(clip.audioGainDb) > 0.001) {
      filters.push_back("volume=" + formatDb(clip.audioGainDb));
    }
    if (clip.audioFadeInUs > 0) {
      filters.push_back("afade=t=in:st=0:d=" + formatSeconds(std::min(clip.audioFadeInUs, outputDurationUs)));
    }
    if (clip.audioFadeOutUs > 0) {
      const auto fadeDurationUs = std::min(clip.audioFadeOutUs, outputDurationUs);
      filters.push_back("afade=t=out:st=" + formatSeconds(std::max<std::int64_t>(0, outputDurationUs - fadeDurationUs)) + ":d=" + formatSeconds(fadeDurationUs));
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
    filters.push_back("atrim=duration=" + formatSeconds(job.durationUs));
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

  void runExportProcess(const std::string& jobId, const std::string& command, const std::string& outputPath) {
    const auto exitCode = runCommandCancellable(command);
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

  int runCommandCancellable(const std::string& command) {
#ifdef _WIN32
    STARTUPINFOA startupInfo{};
    startupInfo.cb = sizeof(startupInfo);
    PROCESS_INFORMATION processInfo{};
    std::string commandLine = command;
    if (!CreateProcessA(nullptr, commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startupInfo, &processInfo)) {
      return static_cast<int>(GetLastError());
    }

    {
      std::lock_guard lock(mutex_);
      activeProcess_ = processInfo.hProcess;
    }
    CloseHandle(processInfo.hThread);

    DWORD waitResult = WAIT_TIMEOUT;
    while ((waitResult = WaitForSingleObject(processInfo.hProcess, 200)) == WAIT_TIMEOUT) {
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
    for (const auto& clip : timeline.clips) {
      const auto* media = findMedia(timeline.media, clip.mediaId);
      if (!media || media->kind != "video" || clip.trackKind != "video" || !clip.trackVisible || clip.outUs <= clip.inUs) {
        continue;
      }
      durationUs = std::max(durationUs, clip.startUs + clipDisplayDurationUs(clip));
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
    return countRenderableVideoClips(job) > 0 || countRenderableAudioClips(job) > 0;
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
