#include "app/EngineApp.hpp"

#include <filesystem>
#include <stdexcept>

namespace ai_editor {

EngineApp::EngineApp()
    : previewServer_("127.0.0.1", 47110),
      ffprobeService_(ffmpegLocator_),
      previewController_(ffmpegLocator_),
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

  if (method == "command.undo") {
    return undoCommand();
  }

  if (method == "command.redo") {
    return redoCommand();
  }

  if (method == "command.history") {
    return session_.commandHistoryJson();
  }

  if (method == "project.create") {
    return createProject(params);
  }

  if (method == "project.open") {
    return openProject(params);
  }

  if (method == "project.save_state") {
    return saveProjectState(params);
  }

  if (method == "project.state") {
    return session_.projectStateJson();
  }

  if (method == "project.reset") {
    return resetProjectState(params);
  }

  if (method == "media.probe") {
    return probeMedia(params);
  }

  if (method == "media.index") {
    return session_.mediaIndexJson();
  }

  if (method == "timeline.state") {
    return session_.timelineJson();
  }

  if (method == "ai.proposals") {
    return session_.proposalsJson();
  }

  if (method == "ai.proposal.generate") {
    return generateProposal(params);
  }

  if (method == "ai.proposal.apply") {
    return applyProposal(params);
  }

  if (method == "ai.proposal.reject") {
    return rejectProposal(params);
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
      {"session", session_.sessionInfo()},
      {"ffmpeg", ffmpeg.toJson()},
      {"ffprobe", ffprobe.toJson()},
      {"gpu", gpu.toJson()},
  };
}

nlohmann::json EngineApp::executeCommand(const nlohmann::json& params) {
  if (params.value("type", std::string{}) == "export_timeline") {
    const auto history = session_.commandHistoryJson();
    return {
        {"ok", true},
        {"commandId", "export_timeline"},
        {"data", exportEngine_.start(params)},
        {"undoCount", history.at("undoCount")},
        {"redoCount", history.at("redoCount")},
    };
  }

  if (params.value("type", std::string{}) == "import_media") {
    return session_.importMedia(params, ffprobeService_);
  }

  if (params.value("type", std::string{}) == "remove_media") {
    return session_.removeMedia(params);
  }

  return session_.executeCommand(params);
}

nlohmann::json EngineApp::undoCommand() {
  return session_.undoCommand();
}

nlohmann::json EngineApp::redoCommand() {
  return session_.redoCommand();
}

nlohmann::json EngineApp::createProject(const nlohmann::json& params) {
  const auto name = params.value("name", std::string{"Untitled Project"});
  const auto path = params.value("path", std::string{});

  if (path.empty()) {
    throw std::runtime_error("project.create requires path");
  }

  const auto project = projectManager_.createProject(path, name);
  nlohmann::json activeProject = {
      {"name", name},
      {"path", project.root.string()},
      {"manifestPath", (project.root / "project.aivproj").string()},
  };
  session_.openDatabase(project.root / project.manifest.database);
  session_.setActiveProject(activeProject);
  session_.saveProjectMetadata();
  auto state = session_.projectStateJson();
  state["summary"] = project.toJson();
  return state;
}

nlohmann::json EngineApp::openProject(const nlohmann::json& params) {
  auto path = params.value("path", std::string{});
  const auto manifestPath = params.value("manifestPath", std::string{});
  if (path.empty() && !manifestPath.empty()) {
    path = std::filesystem::path(manifestPath).parent_path().string();
  }
  if (path.empty()) {
    throw std::runtime_error("project.open requires path or manifestPath");
  }

  const auto root = std::filesystem::path(path);
  const auto resolvedManifestPath = manifestPath.empty() ? root / "project.aivproj" : std::filesystem::path(manifestPath);
  auto manifest = ProjectManifest{};
  if (std::filesystem::exists(resolvedManifestPath)) {
    manifest = ProjectManifest::readFrom(resolvedManifestPath);
  }
  const auto database = root / (manifest.database.empty() ? "project.db" : manifest.database);
  const auto projectName = params.value("name", manifest.name.empty() ? root.filename().string() : manifest.name);
  session_.openDatabase(database);
  session_.setActiveProject({
      {"name", projectName.empty() ? root.filename().string() : projectName},
      {"path", root.string()},
      {"manifestPath", resolvedManifestPath.string()},
      {"lastOpenedAt", params.value("lastOpenedAt", std::string{})},
      {"lastSavedAt", params.value("lastSavedAt", std::string{})},
  });
  session_.saveProjectMetadata();
  return session_.projectStateJson();
}

nlohmann::json EngineApp::saveProjectState(const nlohmann::json& params) {
  session_.replaceState(params, false);
  return session_.projectStateJson();
}

nlohmann::json EngineApp::resetProjectState(const nlohmann::json& params) {
  session_.replaceState(params, true);
  return {
      {"mediaIndex", session_.mediaIndexJson()},
      {"timeline", session_.timelineJson()},
      {"proposals", session_.proposalsJson()},
      {"projectSettings", session_.projectStateJson().at("projectSettings")},
      {"state", session_.projectStateJson()},
  };
}

nlohmann::json EngineApp::probeMedia(const nlohmann::json& params) const {
  const auto path = params.value("path", std::string{});
  if (path.empty()) {
    throw std::runtime_error("media.probe requires path");
  }

  return ffprobeService_.probe(path).toJson();
}

nlohmann::json EngineApp::generateProposal(const nlohmann::json& params) {
  return session_.generateProposal(params);
}

nlohmann::json EngineApp::applyProposal(const nlohmann::json& params) {
  return session_.applyProposal(params);
}

nlohmann::json EngineApp::rejectProposal(const nlohmann::json& params) {
  return session_.rejectProposal(params);
}

}  // namespace ai_editor
