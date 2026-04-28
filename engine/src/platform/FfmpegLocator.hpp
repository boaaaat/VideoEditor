#pragma once

#include <cstdlib>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace ai_editor {

struct ToolLocation {
  bool available = false;
  std::string path;
  std::string message;

  [[nodiscard]] nlohmann::json toJson() const {
    nlohmann::json json = {
        {"available", available},
    };

    if (!path.empty()) {
      json["path"] = path;
    }

    if (!message.empty()) {
      json["message"] = message;
    }

    return json;
  }
};

class FfmpegLocator {
 public:
  [[nodiscard]] ToolLocation locate(const std::string& toolName) const {
    const auto executable = executableName(toolName);

    for (const auto& dir : localToolDirectories()) {
      const auto candidate = dir / executable;
      if (std::filesystem::is_regular_file(candidate)) {
        return {true, candidate.string(), ""};
      }
    }

    if (const auto pathCandidate = findOnPath(executable)) {
      return {true, pathCandidate->string(), ""};
    }

    return {false, "", toolName + " was not found in tools/ffmpeg/bin or PATH"};
  }

 private:
  static std::string executableName(const std::string& toolName) {
#ifdef _WIN32
    return toolName + ".exe";
#else
    return toolName;
#endif
  }

  static std::vector<std::filesystem::path> localToolDirectories() {
    std::vector<std::filesystem::path> dirs;

    if (const char* ffmpegDir = std::getenv("AI_VIDEO_FFMPEG_DIR")) {
      dirs.emplace_back(ffmpegDir);
    }

    auto current = std::filesystem::current_path();
    for (int depth = 0; depth < 6; ++depth) {
      dirs.push_back(current / "tools" / "ffmpeg" / "bin");
      if (!current.has_parent_path()) {
        break;
      }
      current = current.parent_path();
    }

    return dirs;
  }

  static std::optional<std::filesystem::path> findOnPath(const std::string& executable) {
    const char* pathEnv = std::getenv("PATH");
    if (!pathEnv) {
      return std::nullopt;
    }

    std::stringstream stream(pathEnv);
    std::string segment;
    while (std::getline(stream, segment, pathSeparator())) {
      if (segment.empty()) {
        continue;
      }

      const auto candidate = std::filesystem::path(segment) / executable;
      if (std::filesystem::is_regular_file(candidate)) {
        return candidate;
      }
    }

    return std::nullopt;
  }

  static char pathSeparator() {
#ifdef _WIN32
    return ';';
#else
    return ':';
#endif
  }
};

}  // namespace ai_editor
