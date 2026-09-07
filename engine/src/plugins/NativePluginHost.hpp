#pragma once

#include <filesystem>
#include <stdexcept>
#include <string>
#include <nlohmann/json.hpp>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace ai_editor {

class NativePluginHost {
 public:
  // This entry point is called only by the short-lived --run-plugin process.
  static nlohmann::json run(const std::filesystem::path& dllPath, const nlohmann::json& context) {
#ifdef _WIN32
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    const auto module = LoadLibraryExW(dllPath.c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!module) throw std::runtime_error("Could not load native plugin DLL (Windows error " + std::to_string(GetLastError()) + ")");
    const auto version = reinterpret_cast<int (*)()>(GetProcAddress(module, "ai_video_plugin_version"));
    const auto execute = reinterpret_cast<const char* (*)(const char*)>(GetProcAddress(module, "ai_video_plugin_run"));
    const auto release = reinterpret_cast<void (*)(const char*)>(GetProcAddress(module, "ai_video_plugin_free"));
    if (!version || !execute || !release || version() != 1) { FreeLibrary(module); throw std::runtime_error("Native plugin must export the version 1 editor plugin ABI"); }
    const char* output = nullptr;
    try {
      output = execute(context.dump().c_str());
      if (!output) throw std::runtime_error("Native plugin returned no result");
      constexpr std::size_t maxBytes = 2 * 1024 * 1024;
      const auto length = strnlen(output, maxBytes + 1);
      if (length > maxBytes) throw std::runtime_error("Native plugin result exceeds 2 MB");
      auto result = nlohmann::json::parse(output, output + length);
      release(output);
      FreeLibrary(module);
      return result;
    } catch (...) {
      if (output) release(output);
      FreeLibrary(module);
      throw;
    }
#else
    throw std::runtime_error("Native editor plugins require Windows");
#endif
  }

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
