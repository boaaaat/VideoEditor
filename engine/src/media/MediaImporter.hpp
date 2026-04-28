#pragma once

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

namespace ai_editor {

struct MediaImportResult {
  int imported = 0;
  std::vector<std::string> paths;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"imported", imported},
        {"paths", paths},
        {"linked", true},
    };
  }
};

class MediaImporter {
 public:
  MediaImportResult import(const nlohmann::json& command) const {
    if (!command.contains("paths") || !command.at("paths").is_array()) {
      throw std::runtime_error("import_media requires paths");
    }

    MediaImportResult result;
    for (const auto& item : command.at("paths")) {
      const auto path = item.get<std::string>();
      if (!isSupported(path)) {
        throw std::runtime_error("unsupported media type: " + path);
      }

      result.paths.push_back(path);
      result.imported += 1;
    }

    return result;
  }

 private:
  static bool isSupported(const std::string& path) {
    auto extension = std::filesystem::path(path).extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char value) {
      return static_cast<char>(std::tolower(value));
    });

    return extension == ".mp4" || extension == ".mov" || extension == ".mkv" || extension == ".mp3";
  }
};

}  // namespace ai_editor
