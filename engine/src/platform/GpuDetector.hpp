#pragma once

#include <cstdio>
#include <nlohmann/json.hpp>
#include <string>

namespace ai_editor {

struct GpuStatus {
  bool available = false;
  std::string name;
  bool rtx30SeriesOrNewer = false;
  bool nvencAvailable = false;
  std::string message;

  [[nodiscard]] nlohmann::json toJson() const {
    nlohmann::json json = {
        {"available", available},
        {"rtx30SeriesOrNewer", rtx30SeriesOrNewer},
        {"nvencAvailable", nvencAvailable},
    };

    if (!name.empty()) {
      json["name"] = name;
    }

    if (!message.empty()) {
      json["message"] = message;
    }

    return json;
  }
};

class GpuDetector {
 public:
  [[nodiscard]] GpuStatus detect() const {
    const auto gpuName = queryNvidiaName();
    if (gpuName.empty()) {
      return {false, "", false, false, "nvidia-smi did not return an NVIDIA GPU"};
    }

    const bool supported = contains(gpuName, "RTX 30") || contains(gpuName, "RTX 40") ||
                           contains(gpuName, "RTX 50") || contains(gpuName, "RTX A") ||
                           contains(gpuName, "RTX PRO");

    return {
        true,
        gpuName,
        supported,
        supported,
        supported ? "" : "GPU detected, but RTX 30-series or newer was not confirmed",
    };
  }

 private:
  static std::string queryNvidiaName() {
#ifdef _WIN32
    FILE* pipe = _popen("nvidia-smi --query-gpu=name --format=csv,noheader 2>NUL", "r");
#else
    FILE* pipe = popen("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null", "r");
#endif
    if (!pipe) {
      return "";
    }

    char buffer[256];
    std::string output;
    if (fgets(buffer, sizeof(buffer), pipe)) {
      output = buffer;
    }

#ifdef _WIN32
    _pclose(pipe);
#else
    pclose(pipe);
#endif

    while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) {
      output.pop_back();
    }

    return output;
  }

  static bool contains(const std::string& value, const std::string& needle) {
    return value.find(needle) != std::string::npos;
  }
};

}  // namespace ai_editor
