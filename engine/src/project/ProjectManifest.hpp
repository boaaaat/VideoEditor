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

  [[nodiscard]] static ProjectManifest readFrom(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file) {
      throw std::runtime_error("failed to read project manifest: " + path.string());
    }

    nlohmann::json value;
    file >> value;
    ProjectManifest manifest;
    manifest.version = value.value("version", manifest.version);
    manifest.name = value.value("name", manifest.name);
    manifest.database = value.value("database", manifest.database);
    manifest.createdWith = value.value("createdWith", manifest.createdWith);
    return manifest;
  }
};

}  // namespace ai_editor
