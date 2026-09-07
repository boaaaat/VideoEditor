#include "editor_plugin.h"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstring>
#include <string>

AI_VIDEO_PLUGIN_EXPORT int ai_video_plugin_version() { return 1; }
AI_VIDEO_PLUGIN_EXPORT const char* ai_video_plugin_run(const char* input) {
  const auto context = nlohmann::json::parse(input);
  const auto text = context.at("parameters").at("text").get<std::string>();
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto result = nlohmann::json{
    {"summary", "Add a three-second title at the playhead."},
    {"commands", {{{"type", "add_title"}, {"titleId", "native-title-" + std::to_string(stamp)},
      {"text", text}, {"startUs", context.value("playheadUs", 0LL)}, {"durationUs", 3'000'000},
      {"fontSize", 48}, {"positionX", 50}, {"positionY", 80}, {"color", "#ffffff"}, {"background", true}}}}
  }.dump();
  auto* output = new char[result.size() + 1];
  std::memcpy(output, result.c_str(), result.size() + 1);
  return output;
}
AI_VIDEO_PLUGIN_EXPORT void ai_video_plugin_free(const char* output) { delete[] output; }
