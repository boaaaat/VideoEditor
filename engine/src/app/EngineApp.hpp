#pragma once

#include "commands/CommandRegistry.hpp"
#include "ipc/PreviewServer.hpp"
#include "media/MediaImporter.hpp"
#include "platform/FfmpegLocator.hpp"
#include "platform/GpuDetector.hpp"
#include "project/ProjectManager.hpp"

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

  FfmpegLocator ffmpegLocator_;
  GpuDetector gpuDetector_;
  PreviewServer previewServer_;
  ProjectManager projectManager_;
  MediaImporter mediaImporter_;
  CommandRegistry commandRegistry_;
};

}  // namespace ai_editor
