#pragma once

#include <filesystem>
#include <stdexcept>

namespace ai_editor {

class NativePluginHost {
 public:
  void setDeveloperMode(bool enabled) { developerMode_ = enabled; }

  void validateCanLoad(const std::filesystem::path& dllPath) const {
    if (!developerMode_) {
      throw std::runtime_error("C++ plugin loading requires developer mode");
    }

    if (dllPath.extension() != ".dll") {
      throw std::runtime_error("native plugins must be Windows DLL files");
    }
  }

 private:
  bool developerMode_ = false;
};

}  // namespace ai_editor
