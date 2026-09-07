#pragma once

#include "project/ProjectDatabase.hpp"
#include "project/ProjectManifest.hpp"

#include <filesystem>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace ai_editor {

struct ProjectSummary {
  std::string name;
  std::filesystem::path root;
  ProjectManifest manifest;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"name", name},
        {"path", root.string()},
        {"manifest", manifest.toJson()},
    };
  }
};

class ProjectManager {
 public:
  ProjectSummary createProject(const std::filesystem::path& root, const std::string& name) const {
    if (std::filesystem::exists(root / "project.aivproj") || std::filesystem::exists(root / "project.db")) {
      throw std::runtime_error("a project already exists here; open it or choose a different folder");
    }
    const ProjectManifest manifest{1, name, "project.db", "AI Video Editor v0.1"};

    std::filesystem::create_directories(root);
    for (const auto& folder : projectFolders()) {
      std::filesystem::create_directories(root / folder);
    }

    manifest.writeTo(root / "project.aivproj");
    database_.initialize(root / manifest.database);

    return {name, root, manifest};
  }

 private:
  static std::vector<std::string> projectFolders() {
    return {
        "media",
        "proxies",
        "thumbnails",
        "waveforms",
        "cache",
        "luts",
        "plugins",
        "exports",
    };
  }

  ProjectDatabase database_;
};

}  // namespace ai_editor
