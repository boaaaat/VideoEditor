#include "app/EngineApp.hpp"
#include "media/FfprobeService.hpp"
#include "render/ExportEngine.hpp"
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

  ai_editor::GpuStatus gpu;
  gpu.nvencAvailable = true;
  gpu.h264NvencAvailable = true;
  gpu.hevcNvencAvailable = true;
  gpu.av1NvencAvailable = false;
  request.codec = "av1_nvenc";
  const auto av1Errors = ai_editor::ExportEngine::validate(request, gpu);
  assert(!av1Errors.empty());

  std::cout << "engine core tests passed\n";
  return 0;
}
