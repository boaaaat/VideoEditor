#pragma once

#include "render/ExportJob.hpp"

#include <chrono>
#include <string>

namespace ai_editor {

class ExportEngine {
 public:
  [[nodiscard]] ExportJob createJob(const std::string& outputPath) const {
    return {
        "export_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()),
        outputPath,
    };
  }
};

}  // namespace ai_editor
