#pragma once

#include "media/MediaMetadata.hpp"
#include "platform/FfmpegLocator.hpp"

#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <stdexcept>
#include <nlohmann/json.hpp>
#include <string>

namespace ai_editor {

class FfprobeService {
 public:
  explicit FfprobeService(const FfmpegLocator& locator) : locator_(locator) {}

  [[nodiscard]] MediaMetadata probe(const std::string& path) const {
    const auto ffprobe = locator_.locate("ffprobe");
    if (!ffprobe.available) {
      throw std::runtime_error(ffprobe.message);
    }

    const auto command = quoteArg(ffprobe.path) +
                         " -v error -print_format json -show_format -show_streams " +
                         quoteArg(path) + stderrRedirect();
    const auto output = runCommand(command);
    if (output.empty()) {
      throw std::runtime_error("ffprobe returned no metadata for " + path);
    }

    return parseProbeJson(path, nlohmann::json::parse(output));
  }

  [[nodiscard]] static MediaMetadata parseProbeJson(const std::string& path, const nlohmann::json& root) {
    MediaMetadata metadata;
    metadata.path = path;

    const auto streams = root.value("streams", nlohmann::json::array());
    for (const auto& stream : streams) {
      const auto codecType = stream.value("codec_type", std::string{});
      if (codecType == "audio") {
        metadata.hasAudio = true;
        MediaAudioStream audioStream;
        audioStream.index = static_cast<int>(metadata.audioStreams.size());
        audioStream.codec = stream.value("codec_name", std::string{"unknown"});
        audioStream.channels = stream.value("channels", 0);
        if (stream.contains("tags") && stream.at("tags").is_object()) {
          audioStream.title = stream.at("tags").value("title", std::string{});
        }
        metadata.audioStreams.push_back(audioStream);
        continue;
      }

      if (codecType != "video" || metadata.width > 0) {
        continue;
      }

      metadata.width = stream.value("width", 0);
      metadata.height = stream.value("height", 0);
      metadata.codec = stream.value("codec_name", std::string{"unknown"});
      metadata.pixelFormat = stream.value("pix_fmt", std::string{"unknown"});
      metadata.colorTransfer = stream.value("color_transfer", std::string{"unknown"});
      metadata.fps = parseFrameRate(stream.value("avg_frame_rate", std::string{}));
      if (metadata.fps <= 0.0) {
        metadata.fps = parseFrameRate(stream.value("r_frame_rate", std::string{}));
      }

      metadata.durationUs = parseDurationUs(stream.contains("duration") ? stream.at("duration") : nlohmann::json{});
      const auto colorPrimaries = stream.value("color_primaries", std::string{});
      metadata.hdr = isHdrTransfer(metadata.colorTransfer) ||
                     (colorPrimaries == "bt2020" && metadata.pixelFormat.find("10") != std::string::npos);
    }

    if (metadata.durationUs <= 0 && root.contains("format")) {
      metadata.durationUs = parseDurationUs(root.at("format").contains("duration") ? root.at("format").at("duration") : nlohmann::json{});
    }

    return metadata;
  }

 private:
  static double parseFrameRate(const std::string& value) {
    if (value.empty() || value == "0/0") {
      return 0.0;
    }

    const auto slash = value.find('/');
    if (slash == std::string::npos) {
      return parseDouble(value);
    }

    const auto numerator = parseDouble(value.substr(0, slash));
    const auto denominator = parseDouble(value.substr(slash + 1));
    if (denominator == 0.0) {
      return 0.0;
    }

    return numerator / denominator;
  }

  static std::int64_t parseDurationUs(const nlohmann::json& value) {
    double seconds = 0.0;
    if (value.is_string()) {
      seconds = parseDouble(value.get<std::string>());
    } else if (value.is_number()) {
      seconds = value.get<double>();
    }

    return seconds > 0.0 ? static_cast<std::int64_t>(seconds * 1'000'000.0) : 0;
  }

  static double parseDouble(const std::string& value) {
    char* end = nullptr;
    const auto parsed = std::strtod(value.c_str(), &end);
    return end == value.c_str() ? 0.0 : parsed;
  }

  static bool isHdrTransfer(const std::string& transfer) {
    return transfer == "smpte2084" || transfer == "arib-std-b67";
  }

  static std::string runCommand(const std::string& command) {
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (!pipe) {
      throw std::runtime_error("failed to run ffprobe");
    }

    std::ostringstream output;
    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe)) {
      output << buffer;
    }

#ifdef _WIN32
    const auto exitCode = _pclose(pipe);
#else
    const auto exitCode = pclose(pipe);
#endif
    if (exitCode != 0) {
      throw std::runtime_error("ffprobe failed");
    }

    return output.str();
  }

  static std::string quoteArg(const std::string& value) {
    std::string escaped = "\"";
    for (const auto character : value) {
      if (character == '"') {
        escaped += "\\\"";
      } else {
        escaped += character;
      }
    }
    escaped += '"';
    return escaped;
  }

  static std::string stderrRedirect() {
#ifdef _WIN32
    return " 2>NUL";
#else
    return " 2>/dev/null";
#endif
  }

  const FfmpegLocator& locator_;
};

}  // namespace ai_editor
