#pragma once

#include "app/EditorSession.hpp"
#include "commands/CommandRegistry.hpp"
#include "ipc/PreviewServer.hpp"
#include "media/FfprobeService.hpp"
#include "media/MediaImporter.hpp"
#include "playback/PreviewController.hpp"
#include "platform/FfmpegLocator.hpp"
#include "platform/GpuDetector.hpp"
#include "project/ProjectManager.hpp"
#include "render/ExportEngine.hpp"

#include <nlohmann/json.hpp>

namespace ai_editor {

class EngineApp {
 public:
  EngineApp();

  nlohmann::json handleRequest(const nlohmann::json& request);
  nlohmann::json status() const;

 private:
  nlohmann::json executeCommand(const nlohmann::json& params);
  nlohmann::json createProject(const nlohmann::json& params);
  nlohmann::json probeMedia(const nlohmann::json& params) const;
  nlohmann::json generateProposal(const nlohmann::json& params);
  nlohmann::json applyProposal(const nlohmann::json& params);
  nlohmann::json rejectProposal(const nlohmann::json& params);

  FfmpegLocator ffmpegLocator_;
  GpuDetector gpuDetector_;
  PreviewServer previewServer_;
  FfprobeService ffprobeService_;
  PreviewController previewController_;
  ExportEngine exportEngine_;
  ProjectManager projectManager_;
  MediaImporter mediaImporter_;
  CommandRegistry commandRegistry_;
  EditorSession session_;
};

}  // namespace ai_editor
