#include "app/EngineApp.hpp"

#include <stdexcept>

namespace ai_editor {

EngineApp::EngineApp()
    : previewServer_("127.0.0.1", 47110),
      ffprobeService_(ffmpegLocator_),
      previewController_(),
      exportEngine_(ffmpegLocator_, gpuDetector_),
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

  if (method == "media.probe") {
    return probeMedia(params);
  }

  if (method == "preview.attach") {
    return previewController_.attach(params, gpuDetector_.detect());
  }

  if (method == "preview.resize") {
    return previewController_.resize(params);
  }

  if (method == "preview.set_state") {
    return previewController_.setState(params);
  }

  if (method == "preview.play") {
    return previewController_.play();
  }

  if (method == "preview.pause") {
    return previewController_.pause();
  }

  if (method == "preview.seek") {
    return previewController_.seek(params);
  }

  if (method == "preview.stats") {
    return previewController_.stats();
  }

  if (method == "export.start") {
    return exportEngine_.start(params);
  }

  if (method == "export.cancel") {
    return exportEngine_.cancel();
  }

  if (method == "export.status") {
    return exportEngine_.status();
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
  if (params.value("type", std::string{}) == "export_timeline") {
    auto result = commandRegistry_.execute(params);
    result["data"] = exportEngine_.start(params);
    return result;
  }

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

nlohmann::json EngineApp::probeMedia(const nlohmann::json& params) const {
  const auto path = params.value("path", std::string{});
  if (path.empty()) {
    throw std::runtime_error("media.probe requires path");
  }

  return ffprobeService_.probe(path).toJson();
}

}  // namespace ai_editor
