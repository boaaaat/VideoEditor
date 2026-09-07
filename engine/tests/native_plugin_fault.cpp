#include "editor_plugin.h"
#include <windows.h>
#include <cstring>

// Deliberately exits or hangs only inside the disposable plugin host process.
AI_VIDEO_PLUGIN_EXPORT int ai_video_plugin_version() { return 1; }
AI_VIDEO_PLUGIN_EXPORT const char* ai_video_plugin_run(const char* context) {
  if (std::strstr(context, "timeout")) Sleep(60'000);
  ExitProcess(23);
  return nullptr;
}
AI_VIDEO_PLUGIN_EXPORT void ai_video_plugin_free(const char*) {}
