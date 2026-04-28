#include "app/EngineApp.hpp"
#include "timeline/TimelineService.hpp"

#include <cassert>
#include <iostream>

int main() {
  ai_editor::EngineApp app;
  const auto status = app.status();
  assert(status.at("appName") == "AI Video Editor");
  assert(status.contains("ffmpeg"));
  assert(status.contains("gpu"));

  const auto commandResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 1},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "split_clip"},
           {"playheadUs", 1000000},
       }},
  });
  assert(commandResult.at("ok") == true);

  ai_editor::Timeline timeline;
  ai_editor::Track track;
  track.id = "v1";
  track.clips.push_back({"a", "m1", "v1", 0, 0, 1000000, {}});
  track.clips.push_back({"b", "m2", "v1", 2000000, 0, 1000000, {}});
  timeline.tracks.push_back(track);

  ai_editor::TimelineService::rippleDelete(timeline, "a");
  assert(timeline.tracks.at(0).clips.size() == 1);
  assert(timeline.tracks.at(0).clips.at(0).startUs == 1000000);

  std::cout << "engine core tests passed\n";
  return 0;
}
