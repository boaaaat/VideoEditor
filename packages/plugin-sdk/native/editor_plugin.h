#pragma once

// Build a 64-bit Windows DLL. The returned UTF-8 JSON is owned by the plugin
// until the host calls ai_video_plugin_free. Do not write to stdout.
#ifdef _WIN32
#define AI_VIDEO_PLUGIN_EXPORT extern "C" __declspec(dllexport)
#else
#define AI_VIDEO_PLUGIN_EXPORT extern "C"
#endif

AI_VIDEO_PLUGIN_EXPORT int ai_video_plugin_version(); // Return 1.
AI_VIDEO_PLUGIN_EXPORT const char* ai_video_plugin_run(const char* context_json);
AI_VIDEO_PLUGIN_EXPORT void ai_video_plugin_free(const char* result_json);
