#pragma once

#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>

namespace ai_editor {

struct ProjectManifest {
  int version = 1;
  std::string name;
  std::string database = "project.db";
  std::string createdWith = "AI Video Editor v0.1";

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"version", version},
        {"name", name},
        {"database", database},
        {"createdWith", createdWith},
    };
  }

  void writeTo(const std::filesystem::path& path) const {
    std::ofstream file(path, std::ios::trunc);
    if (!file) {
      throw std::runtime_error("failed to write project manifest: " + path.string());
    }

    file << toJson().dump(2) << '\n';
  }
};

}  // namespace ai_editor
