#include "app/EngineApp.hpp"

#include <stdexcept>

namespace ai_editor {

EngineApp::EngineApp()
    : previewServer_("127.0.0.1", 47110),
      mediaImporter_(),
      commandRegistry_(mediaImporter_) {}

nlohmann::json EngineApp::handleRequest(const nlohmann::json& request) {
  const auto method = request.value("method", std::string{});
  const auto params = request.contains("params") ? request.at("params") : nlohmann::json::object();

  if (method == "engine.status") {
    return status();
  }

  if (method == "command.execute") {
    return executeCommand(params);
  }

  if (method == "project.create") {
    return createProject(params);
  }

  throw std::runtime_error("unknown engine method: " + method);
}

nlohmann::json EngineApp::status() const {
  const auto ffmpeg = ffmpegLocator_.locate("ffmpeg");
  const auto ffprobe = ffmpegLocator_.locate("ffprobe");
  const auto gpu = gpuDetector_.detect();

  return {
      {"appName", "AI Video Editor"},
      {"version", "0.1.0"},
      {"previewUrl", previewServer_.url()},
      {"ffmpeg", ffmpeg.toJson()},
      {"ffprobe", ffprobe.toJson()},
      {"gpu", gpu.toJson()},
  };
}

nlohmann::json EngineApp::executeCommand(const nlohmann::json& params) {
  return commandRegistry_.execute(params);
}

nlohmann::json EngineApp::createProject(const nlohmann::json& params) {
  const auto name = params.value("name", std::string{"Untitled Project"});
  const auto path = params.value("path", std::string{});

  if (path.empty()) {
    throw std::runtime_error("project.create requires path");
  }

  const auto project = projectManager_.createProject(path, name);
  return project.toJson();
}

}  // namespace ai_editor
