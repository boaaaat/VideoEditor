#include "app/EngineApp.hpp"
#include "media/FfprobeService.hpp"
#include "render/ExportEngine.hpp"
#include "timeline/TimelineService.hpp"

#include <cassert>
#include <filesystem>
#include <iostream>
#include <stdexcept>

#undef assert
#define assert(expr)                                                                                                    \
  do {                                                                                                                  \
    if (!(expr)) {                                                                                                      \
      throw std::runtime_error(std::string("assertion failed: ") + #expr);                                             \
    }                                                                                                                   \
  } while (false)

int runTests() {
  const auto testDb = std::filesystem::absolute("engine-session-test.db");
  std::filesystem::remove(testDb);
#ifdef _WIN32
  _putenv_s("AI_VIDEO_SESSION_DB", testDb.string().c_str());
#else
  setenv("AI_VIDEO_SESSION_DB", testDb.string().c_str(), 1);
#endif

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

  const auto metadata = ai_editor::FfprobeService::parseProbeJson(
      "sample.mp4",
      {
          {"streams",
           {
               {
                   {"codec_type", "video"},
                   {"codec_name", "hevc"},
                   {"width", 3840},
                   {"height", 2160},
                   {"avg_frame_rate", "60000/1001"},
                   {"duration", "12.500000"},
                   {"pix_fmt", "yuv420p10le"},
                   {"color_transfer", "smpte2084"},
                   {"color_primaries", "bt2020"},
               },
               {
                   {"codec_type", "audio"},
                   {"codec_name", "aac"},
               },
           }},
          {"format", {{"duration", "12.500000"}}},
      });
  assert(metadata.width == 3840);
  assert(metadata.height == 2160);
  assert(metadata.codec == "hevc");
  assert(metadata.fps > 59.0 && metadata.fps < 60.0);
  assert(metadata.durationUs == 12500000);
  assert(metadata.hdr);
  assert(metadata.hasAudio);

  ai_editor::ExportRequest request;
  request.outputPath = "C:\\exports\\movie.mp4";
  request.resolution = "4k";
  request.width = 3840;
  request.height = 2160;
  request.fps = 60;
  request.codec = "hevc_nvenc";
  request.container = "mp4";
  request.quality = "high";
  request.colorMode = "HDR";
  request.audioEnabled = false;
  request.bitrateMbps = ai_editor::ExportEngine::calculateBitrateMbps(request);
  assert(request.bitrateMbps > 100);

  ai_editor::ExportJob exportJob;
  exportJob.outputPath = request.outputPath;
  exportJob.resolution = request.resolution;
  exportJob.width = request.width;
  exportJob.height = request.height;
  exportJob.fps = request.fps;
  exportJob.codec = request.codec;
  exportJob.container = request.container;
  exportJob.quality = request.quality;
  exportJob.colorMode = request.colorMode;
  exportJob.audioEnabled = request.audioEnabled;
  exportJob.bitrateMbps = request.bitrateMbps;
  const auto command = ai_editor::ExportEngine::buildFfmpegCommand(exportJob);
  assert(command.find("hevc_nvenc") != std::string::npos);
  assert(command.find("p010le") != std::string::npos);
  assert(command.find("-an") != std::string::npos);

  ai_editor::ExportJob timelineExportJob;
  timelineExportJob.outputPath = request.outputPath;
  timelineExportJob.width = 1920;
  timelineExportJob.height = 1080;
  timelineExportJob.fps = 30;
  timelineExportJob.durationUs = 6'000'000;
  timelineExportJob.codec = "h264_nvenc";
  timelineExportJob.container = "mp4";
  timelineExportJob.quality = "medium";
  timelineExportJob.audioEnabled = true;
  timelineExportJob.bitrateMbps = 16;
  timelineExportJob.masterGainDb = -3;
  timelineExportJob.normalizeAudio = true;
  timelineExportJob.timeline.media.push_back({"media_a", "C:\\media\\clip-a.mp4", "video", true});
  timelineExportJob.timeline.clips.push_back({"media_a", "v1", "video", 1, true, false, 1'000'000, 500'000, 3'500'000, 4, false, 250'000, 500'000, true, true});
  timelineExportJob.timeline.clips.back().brightness = 12;
  timelineExportJob.timeline.clips.back().contrast = 20;
  timelineExportJob.timeline.clips.back().lutId = "filmic";
  timelineExportJob.timeline.clips.back().lutStrength = 0.75;
  timelineExportJob.timeline.clips.back().scale = 1.15;
  timelineExportJob.timeline.clips.back().positionX = 24;
  timelineExportJob.timeline.clips.back().effects.push_back({"blur", "blur", "Blur", true, 18});
  const auto timelineCommand = ai_editor::ExportEngine::buildFfmpegCommand(timelineExportJob);
  assert(timelineCommand.find("C:\\media\\clip-a.mp4") != std::string::npos);
  assert(timelineCommand.find("filter_complex") != std::string::npos);
  assert(timelineCommand.find("concat=n=3") != std::string::npos);
  assert(timelineCommand.find("atrim=start=0.500") != std::string::npos);
  assert(timelineCommand.find("volume=4.00dB") != std::string::npos);
  assert(timelineCommand.find("volume=-3.00dB") != std::string::npos);
  assert(timelineCommand.find("afade=t=in") != std::string::npos);
  assert(timelineCommand.find("loudnorm") != std::string::npos);
  assert(timelineCommand.find("eq=brightness=0.1200") != std::string::npos);
  assert(timelineCommand.find("curves=preset=medium_contrast") != std::string::npos);
  assert(timelineCommand.find("overlay=x=(W-w)/2+24.0000") != std::string::npos);
  assert(timelineCommand.find("gblur=sigma=1.0000") != std::string::npos);

  ai_editor::GpuStatus gpu;
  gpu.nvencAvailable = true;
  gpu.h264NvencAvailable = true;
  gpu.hevcNvencAvailable = true;
  gpu.av1NvencAvailable = false;
  request.codec = "av1_nvenc";
  const auto av1Errors = ai_editor::ExportEngine::validate(request, gpu);
  assert(!av1Errors.empty());

  const auto importResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 2},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "import_media"},
           {"paths", {"sample-a.mp4", "sample-b.mp4"}},
       }},
  });
  assert(importResult.at("ok") == true);
  assert(importResult.at("data").at("media").size() == 2);
  const auto mediaId = importResult.at("data").at("media").at(0).at("id").get<std::string>();
  assert(importResult.at("data").at("media").at(0).at("metadata").at("width") == 0);
  assert(importResult.at("data").at("media").at(0).at("metadata").at("height") == 0);
  assert(importResult.at("data").at("media").at(0).at("metadata").at("fps") == 0.0);
  assert(importResult.at("data").at("media").at(0).at("intelligence").at("transcript").at("status") == "placeholder");
  assert(importResult.at("data").at("media").at(0).at("intelligence").at("sceneCuts").at("status") == "placeholder");

  const auto addClipResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 3},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "add_clip"},
           {"mediaId", mediaId},
           {"trackId", "v1"},
           {"startUs", 0},
           {"inUs", 0},
           {"outUs", 5000000},
       }},
  });
  assert(addClipResult.at("ok") == true);
  const auto timelineState = app.handleRequest({{"jsonrpc", "2.0"}, {"id", 4}, {"method", "timeline.state"}});
  assert(timelineState.at("tracks").at(1).at("clips").size() == 1);

  const auto removeResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 5},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "remove_media"},
           {"mediaId", mediaId},
       }},
  });
  assert(removeResult.at("ok") == true);
  assert(removeResult.at("data").at("mediaIndex").at("media").size() == 1);
  assert(removeResult.at("data").at("timeline").at("tracks").at(1).at("clips").empty());

  const auto reimportResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 6},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "import_media"},
           {"paths", {"sample-a.mp4"}},
       }},
  });
  assert(reimportResult.at("ok") == true);
  const auto reimportedMediaId = reimportResult.at("data").at("media").at(0).at("id").get<std::string>();
  assert(reimportedMediaId == mediaId);

  const auto reAddClipResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 7},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "add_clip"},
           {"mediaId", mediaId},
           {"trackId", "v1"},
           {"startUs", 0},
           {"inUs", 0},
           {"outUs", 5000000},
       }},
  });
  assert(reAddClipResult.at("ok") == true);

  ai_editor::EngineApp reloadedApp;
  const auto reloadedTimeline = reloadedApp.handleRequest({{"jsonrpc", "2.0"}, {"id", 8}, {"method", "timeline.state"}});
  assert(reloadedTimeline.at("tracks").at(1).at("clips").size() == 1);

  const auto proposal = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 9},
      {"method", "ai.proposal.generate"},
      {"params",
       {
           {"goal", "make a 10 second YouTube intro cut"},
           {"mediaIds", {mediaId}},
       }},
  });
  assert(proposal.at("status") == "pending");
  assert(proposal.at("commands").is_array());
  assert(!proposal.at("commands").empty());

  const auto appliedProposal = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 10},
      {"method", "ai.proposal.apply"},
      {"params", {{"proposalId", proposal.at("id")}}},
  });
  assert(appliedProposal.at("status") == "applied");

  const auto resetResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 11},
      {"method", "project.reset"},
      {"params",
       {
           {"mediaAssets", nlohmann::json::array()},
           {"aiProposals", nlohmann::json::array()},
           {"timeline",
            {
                {"id", "timeline_main"},
                {"name", "Main Timeline"},
                {"fps", 30},
                {"durationUs", 10000000},
                {"tracks",
                 {
                     {{"id", "v2"}, {"name", "Video 2"}, {"kind", "video"}, {"index", 0}, {"locked", false}, {"muted", false}, {"visible", true}, {"clips", nlohmann::json::array()}},
                     {{"id", "v1"}, {"name", "Video 1"}, {"kind", "video"}, {"index", 1}, {"locked", false}, {"muted", false}, {"visible", true}, {"clips", nlohmann::json::array()}},
                     {{"id", "a1"}, {"name", "Audio 1"}, {"kind", "audio"}, {"index", 2}, {"locked", false}, {"muted", false}, {"visible", true}, {"clips", nlohmann::json::array()}},
                 }},
            }},
       }},
  });
  assert(resetResult.at("mediaIndex").at("media").empty());
  assert(resetResult.at("timeline").at("tracks").at(1).at("clips").empty());
  assert(resetResult.at("proposals").at("proposals").empty());

  std::cout << "engine core tests passed\n";
  return 0;
}

int main() {
  try {
    return runTests();
  } catch (const std::exception& error) {
    std::cerr << "engine core tests failed: " << error.what() << '\n';
    return 1;
  }
}
