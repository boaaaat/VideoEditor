#include "app/EngineApp.hpp"
#include "media/FfprobeService.hpp"
#include "render/ExportEngine.hpp"
#include "timeline/TimelineService.hpp"

#include <algorithm>
#include <cassert>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <regex>
#include <stdexcept>

#undef assert
#define assert(expr)                                                                                                    \
  do {                                                                                                                  \
    if (!(expr)) {                                                                                                      \
      throw std::runtime_error(std::string("assertion failed: ") + #expr);                                             \
    }                                                                                                                   \
  } while (false)

int runTests() {
  const auto mediaFixtures = std::filesystem::absolute("engine-core-media-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(mediaFixtures);
  const auto writeBmp = [](const std::filesystem::path& path, unsigned char red) {
    constexpr int width = 64, height = 36, dataSize = width * height * 3;
    std::vector<unsigned char> bytes(54 + dataSize, 0);
    const auto number = [&](int offset, unsigned int value, int count = 4) { for (int i = 0; i < count; ++i) bytes[offset+i] = static_cast<unsigned char>(value >> (i*8)); };
    bytes[0] = 'B'; bytes[1] = 'M'; number(2, bytes.size()); number(10, 54); number(14, 40);
    number(18, width); number(22, height); number(26, 1, 2); number(28, 24, 2); number(34, dataSize);
    for (int pixel = 54; pixel < static_cast<int>(bytes.size()); pixel += 3) bytes[pixel+2] = red;
    std::ofstream file(path, std::ios::binary); file.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
  };
  const auto sampleA = (mediaFixtures / "sample-a.bmp").string();
  const auto sampleB = (mediaFixtures / "sample-b.bmp").string();
  const auto lockedSource = (mediaFixtures / "locked-media.bmp").string();
  writeBmp(sampleA, 255); writeBmp(sampleB, 100); writeBmp(lockedSource, 50);
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

  const auto previewState = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 10},
      {"method", "preview.set_state"},
      {"params",
       {
           {"mediaPath", ""},
           {"playheadUs", 0},
       }},
  });
  assert(previewState.at("renderMode") == "fallback");
  assert(previewState.contains("frameDataUrl"));

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
                   {"index", 1},
                   {"channels", 2},
               },
               {
                   {"codec_type", "audio"},
                   {"codec_name", "aac"},
                   {"index", 2},
                   {"channels", 1},
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
  assert(metadata.audioStreams.size() == 2);
  assert(metadata.audioStreams.at(0).index == 0);

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
  // 4K60 HDR high-quality HEVC: 16 * 4 * 2 * 1.25 * .85 * .72 = 98 Mbps.
  assert(request.bitrateMbps == 98);

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
  assert(timelineCommand.find("eof_action=pass:repeatlast=0") != std::string::npos);
  assert(timelineCommand.find("lookahead_level") == std::string::npos);
  assert(timelineCommand.find("extra_hw_frames") == std::string::npos);
  // Input seeking already removes the source in-point before the audio filter.
  assert(timelineCommand.find("-ss 0.500") != std::string::npos);
  assert(timelineCommand.find("atrim=start=0:duration=3.000") != std::string::npos);
  assert(timelineCommand.find("volume=4.00dB") != std::string::npos);
  assert(timelineCommand.find("volume=-3.00dB") != std::string::npos);
  assert(timelineCommand.find("afade=t=in") != std::string::npos);
  assert(timelineCommand.find("loudnorm") != std::string::npos);
  assert(timelineCommand.find("eq=brightness=0.1200") != std::string::npos);
  assert(timelineCommand.find("curves=all='0/0 0.25/0.2125 0.75/0.7875 1/1'") != std::string::npos);
  assert(timelineCommand.find("overlay=x=(W-w)/2+24.0000") != std::string::npos);
  assert(timelineCommand.find("gblur=sigma=1.0000") != std::string::npos);

  ai_editor::ExportJob speedExportJob;
  speedExportJob.outputPath = request.outputPath;
  speedExportJob.width = 1920;
  speedExportJob.height = 1080;
  speedExportJob.fps = 30;
  speedExportJob.durationUs = 4'000'000;
  speedExportJob.codec = "h264_nvenc";
  speedExportJob.container = "mp4";
  speedExportJob.quality = "medium";
  speedExportJob.audioEnabled = true;
  speedExportJob.bitrateMbps = 12;
  speedExportJob.timeline.media.push_back({"video_speed", "C:\\media\\video-speed.mp4", "video", true});
  speedExportJob.timeline.media.push_back({"audio_speed", "C:\\media\\audio-speed.wav", "audio", true});
  speedExportJob.timeline.clips.push_back({"video_speed", "v1", "video", 0, true, false, 0, 0, 4'000'000});
  speedExportJob.timeline.clips.back().speedPercent = 200.0;
  speedExportJob.timeline.clips.push_back({"audio_speed", "a1", "audio", 1, true, false, 0, 0, 2'000'000});
  speedExportJob.timeline.clips.back().speedPercent = 50.0;
  const auto speedCommand = ai_editor::ExportEngine::buildFfmpegCommand(speedExportJob);
  assert(speedCommand.find("setpts=(PTS-STARTPTS)/2.0000") != std::string::npos);
  assert(speedCommand.find("atempo=2.0000") != std::string::npos);
  assert(speedCommand.find("atempo=0.5000") != std::string::npos);

  ai_editor::ExportJob multiAudioExportJob;
  multiAudioExportJob.outputPath = request.outputPath;
  multiAudioExportJob.width = 1920;
  multiAudioExportJob.height = 1080;
  multiAudioExportJob.fps = 30;
  multiAudioExportJob.durationUs = 4'000'000;
  multiAudioExportJob.codec = "h264_nvenc";
  multiAudioExportJob.container = "mp4";
  multiAudioExportJob.quality = "medium";
  multiAudioExportJob.audioEnabled = true;
  multiAudioExportJob.bitrateMbps = 12;
  multiAudioExportJob.timeline.media.push_back({"dual_audio", "C:\\media\\dual-audio.mp4", "video", true});
  ai_editor::ExportTimelineClip mutedVideoClip;
  mutedVideoClip.mediaId = "dual_audio";
  mutedVideoClip.trackId = "v1";
  mutedVideoClip.trackKind = "video";
  mutedVideoClip.trackIndex = 0;
  mutedVideoClip.startUs = 0;
  mutedVideoClip.inUs = 0;
  mutedVideoClip.outUs = 4'000'000;
  mutedVideoClip.audioMuted = true;
  multiAudioExportJob.timeline.clips.push_back(mutedVideoClip);
  ai_editor::ExportTimelineClip gameAudioClip;
  gameAudioClip.mediaId = "dual_audio";
  gameAudioClip.trackId = "a1";
  gameAudioClip.trackKind = "audio";
  gameAudioClip.trackIndex = 1;
  gameAudioClip.startUs = 0;
  gameAudioClip.inUs = 0;
  gameAudioClip.outUs = 4'000'000;
  gameAudioClip.audioStreamIndex = 0;
  multiAudioExportJob.timeline.clips.push_back(gameAudioClip);
  ai_editor::ExportTimelineClip micAudioClip = gameAudioClip;
  micAudioClip.trackId = "a2";
  micAudioClip.trackIndex = 2;
  micAudioClip.audioStreamIndex = 1;
  multiAudioExportJob.timeline.clips.push_back(micAudioClip);
  const auto multiAudioCommand = ai_editor::ExportEngine::buildFfmpegCommand(multiAudioExportJob);
  assert(multiAudioCommand.find(":a:0]") != std::string::npos);
  assert(multiAudioCommand.find(":a:1]") != std::string::npos);
  assert(multiAudioCommand.find("amix=inputs=2") != std::string::npos);

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
           {"paths", {sampleA, sampleB}},
       }},
  });
  assert(importResult.at("ok") == true);
  assert(importResult.at("data").at("media").size() == 2);
  const auto mediaId = importResult.at("data").at("media").at(0).at("id").get<std::string>();
  assert(importResult.at("data").at("media").at(0).at("metadata").at("width") == 64);
  assert(importResult.at("data").at("media").at(0).at("metadata").at("height") == 36);
  assert(importResult.at("data").at("media").at(0).at("metadata").at("isStillImage") == true);
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
           {"paths", {sampleA}},
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
  const auto reAddedClipId = reAddClipResult.at("data").at("timeline").at("tracks").at(1).at("clips").at(0).at("id").get<std::string>();

  const auto speedResult = app.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 12},
      {"method", "command.execute"},
      {"params",
       {
           {"type", "apply_clip_speed"},
           {"clipId", reAddedClipId},
           {"speedPercent", 50},
       }},
  });
  assert(speedResult.at("ok") == true);
  assert(speedResult.at("data").at("timeline").at("tracks").at(1).at("clips").at(0).at("speedPercent") == 50.0);

  ai_editor::EngineApp reloadedApp;
  const auto reloadedTimeline = reloadedApp.handleRequest({{"jsonrpc", "2.0"}, {"id", 8}, {"method", "timeline.state"}});
  assert(reloadedTimeline.at("tracks").at(1).at("clips").size() == 1);
  assert(reloadedTimeline.at("tracks").at(1).at("clips").at(0).at("speedPercent") == 50.0);

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

  const auto addTrackResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 13},
      {"method", "command.execute"},
      {"params", {{"type", "add_track"}, {"kind", "video"}, {"trackId", "v3"}, {"name", "Video 3"}}},
  });
  assert(addTrackResult.at("undoCount") == 1);
  assert(addTrackResult.at("redoCount") == 0);

  const auto undoResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 14},
      {"method", "command.undo"},
      {"params", nlohmann::json::object()},
  });
  assert(undoResult.at("ok") == true);
  assert(undoResult.at("undoCount") == 0);
  assert(undoResult.at("redoCount") == 1);
  assert(undoResult.at("data").at("timeline").at("tracks").size() == resetResult.at("timeline").at("tracks").size());

  const auto redoResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 15},
      {"method", "command.redo"},
      {"params", nlohmann::json::object()},
  });
  assert(redoResult.at("ok") == true);
  assert(redoResult.at("undoCount") == 1);
  assert(redoResult.at("redoCount") == 0);
  assert(redoResult.at("data").at("timeline").at("tracks").size() == resetResult.at("timeline").at("tracks").size() + 1);

  const auto updateTrackResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 151},
      {"method", "command.execute"},
      {"params", {{"type", "update_track"}, {"trackId", "v3"}, {"name", "Renamed Video"}, {"locked", true}, {"visible", false}}},
  });
  assert(updateTrackResult.at("ok") == true);
  const auto updatedTracks = updateTrackResult.at("data").at("timeline").at("tracks");
  const auto updatedTrack = std::find_if(updatedTracks.begin(), updatedTracks.end(), [](const nlohmann::json& track) {
    return track.at("id") == "v3";
  });
  assert(updatedTrack != updatedTracks.end());
  assert(updatedTrack->at("name") == "Renamed Video");
  assert(updatedTrack->at("locked") == true);
  assert(updatedTrack->at("visible") == false);

  const auto noOpTrackResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 152},
      {"method", "command.execute"},
      {"params", {{"type", "update_track"}, {"trackId", "v3"}, {"name", "Renamed Video"}, {"locked", true}, {"visible", false}}},
  });
  assert(noOpTrackResult.at("ok") == true);
  assert(noOpTrackResult.at("undoCount") == updateTrackResult.at("undoCount"));

  const auto coalescedTrackResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 153},
      {"method", "command.execute"},
      {"params", {{"type", "update_track"}, {"trackId", "v3"}, {"name", "Coalesced 1"}, {"history", {{"mode", "replace"}, {"group", "track-name:v3"}}}}},
  });
  assert(coalescedTrackResult.at("undoCount") == updateTrackResult.at("undoCount").get<int>() + 1);
  const auto coalescedTrackResult2 = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 154},
      {"method", "command.execute"},
      {"params", {{"type", "update_track"}, {"trackId", "v3"}, {"name", "Coalesced 2"}, {"history", {{"mode", "replace"}, {"group", "track-name:v3"}}}}},
  });
  assert(coalescedTrackResult2.at("undoCount") == coalescedTrackResult.at("undoCount"));

  const auto undoCoalescedResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 155},
      {"method", "command.undo"},
      {"params", nlohmann::json::object()},
  });
  const auto undoCoalescedTracks = undoCoalescedResult.at("data").at("timeline").at("tracks");
  const auto undoCoalescedTrack = std::find_if(undoCoalescedTracks.begin(), undoCoalescedTracks.end(), [](const nlohmann::json& track) {
    return track.at("id") == "v3";
  });
  assert(undoCoalescedTrack != undoCoalescedTracks.end());
  assert(undoCoalescedTrack->at("name") == "Renamed Video");

  const auto relockTrackResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 156},
      {"method", "command.execute"},
      {"params", {{"type", "update_track"}, {"trackId", "v3"}, {"locked", true}}},
  });
  assert(relockTrackResult.at("ok") == true);

  const auto lockedMediaResult = reloadedApp.handleRequest({
      {"jsonrpc", "2.0"},
      {"id", 157},
      {"method", "command.execute"},
      {"params", {{"type", "import_media"}, {"paths", {lockedSource}}}},
  });
  const auto lockedMediaId = lockedMediaResult.at("data").at("media").at(0).at("id").get<std::string>();
  bool lockedAddRejected = false;
  try {
    (void)reloadedApp.handleRequest({
        {"jsonrpc", "2.0"},
        {"id", 158},
        {"method", "command.execute"},
        {"params", {{"type", "add_clip"}, {"mediaId", lockedMediaId}, {"trackId", "v3"}, {"startUs", 0}}},
    });
  } catch (const std::exception&) {
    lockedAddRejected = true;
  }
  assert(lockedAddRejected);

  for (int index = 0; index < 205; ++index) {
    const auto cappedResult = reloadedApp.handleRequest({
        {"jsonrpc", "2.0"},
        {"id", 2000 + index},
        {"method", "command.execute"},
        {"params", {{"type", "add_track"}, {"kind", "audio"}, {"trackId", "history_cap_" + std::to_string(index)}, {"name", "History Cap " + std::to_string(index)}}},
    });
    assert(cappedResult.at("undoCount") <= 200);
  }
  const auto cappedHistory = reloadedApp.handleRequest({{"jsonrpc", "2.0"}, {"id", 2206}, {"method", "command.history"}});
  assert(cappedHistory.at("undoCount") == 200);

  const auto projectRoot = std::filesystem::absolute("engine-project-db-test");
  std::filesystem::remove_all(projectRoot);
  std::size_t createdProjectTrackCount = 0;

  {
    ai_editor::EngineApp projectApp;
    const auto createdProject = projectApp.handleRequest({
        {"jsonrpc", "2.0"},
        {"id", 16},
        {"method", "project.create"},
        {"params", {{"name", "Project DB Test"}, {"path", projectRoot.string()}}},
    });
    assert(std::regex_match(
        createdProject.at("savedAt").get<std::string>(),
        std::regex(R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$)")));
    assert(createdProject.at("projectSettings").at("width") == 1920);
    createdProjectTrackCount = createdProject.at("timeline").at("tracks").size();

    auto projectSettings = createdProject.at("projectSettings");
    projectSettings["width"] = 1280;
    projectSettings["height"] = 720;
    const auto savedProject = projectApp.handleRequest({
        {"jsonrpc", "2.0"},
        {"id", 17},
        {"method", "project.save_state"},
        {"params",
         {
             {"version", 1},
             {"savedAt", "2026-01-01T00:00:00.000Z"},
             {"project", createdProject.at("project")},
             {"projectSettings", projectSettings},
             {"mediaAssets", nlohmann::json::array()},
             {"timeline", createdProject.at("timeline")},
             {"aiProposals", nlohmann::json::array()},
         }},
    });
    assert(savedProject.at("projectSettings").at("width") == 1280);
  }

  {
    ai_editor::EngineApp projectReloadedApp;
    const auto reopenedProject = projectReloadedApp.handleRequest({
        {"jsonrpc", "2.0"},
        {"id", 18},
        {"method", "project.open"},
        {"params", {{"name", "Project DB Test"}, {"path", projectRoot.string()}}},
    });
    assert(reopenedProject.at("projectSettings").at("width") == 1280);
    assert(reopenedProject.at("projectSettings").at("height") == 720);
    assert(reopenedProject.at("timeline").at("tracks").size() == createdProjectTrackCount);
    const auto stableProject = reopenedProject;
    auto run = [&](const std::string& method, const nlohmann::json& params) {
      return projectReloadedApp.handleRequest({{"jsonrpc", "2.0"}, {"id", 19}, {"method", method}, {"params", params}});
    };
    run("command.execute", {{"type", "add_marker"}, {"markerId", "switch_safety"}, {"timeUs", 1000}, {"name", "Keep me"}});
    const auto stableState = run("project.state", {});
    const auto stableHistory = run("command.history", {});
    const auto brokenRoot = projectRoot / "broken";
    std::filesystem::create_directories(brokenRoot);
    ai_editor::ProjectManifest{1, "Broken", "project.db", "test"}.writeTo(brokenRoot / "project.aivproj");
    // A missing database must not be silently created as an empty project.
    bool rejected = false;
    try { run("project.open", {{"path", brokenRoot.string()}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(!std::filesystem::exists(brokenRoot / "project.db"));
    {
      std::ofstream corrupt(brokenRoot / "project.db", std::ios::binary);
      corrupt << "This is not a SQLite database";
    }
    rejected = false;
    try { run("project.open", {{"path", brokenRoot.string()}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(run("project.state", {}) == stableState);
    assert(run("command.history", {}) == stableHistory);
    // A valid SQLite file can still contain a malformed project row. Loading it
    // must roll back schema migration and leave the previous connection usable.
    std::filesystem::remove(brokenRoot / "project.db");
    sqlite3* malformedDb = nullptr;
    assert(sqlite3_open((brokenRoot / "project.db").string().c_str(), &malformedDb) == SQLITE_OK);
    assert(sqlite3_exec(malformedDb, "CREATE TABLE app_state(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO app_state VALUES('timeline_markers','invalid json','test');", nullptr, nullptr, nullptr) == SQLITE_OK);
    sqlite3_close(malformedDb);
    rejected = false;
    try { run("project.open", {{"path", brokenRoot.string()}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(run("project.state", {}) == stableState);
    assert(run("command.history", {}) == stableHistory);
    assert(sqlite3_open((brokenRoot / "project.db").string().c_str(), &malformedDb) == SQLITE_OK);
    sqlite3_stmt* schemaCount = nullptr;
    assert(sqlite3_prepare_v2(malformedDb, "SELECT COUNT(*) FROM sqlite_master WHERE type='table';", -1, &schemaCount, nullptr) == SQLITE_OK);
    assert(sqlite3_step(schemaCount) == SQLITE_ROW);
    assert(sqlite3_column_int(schemaCount, 0) == 1);
    sqlite3_finalize(schemaCount);
    sqlite3_close(malformedDb);
    auto wrongProjectSnapshot = stableState;
    wrongProjectSnapshot["project"]["path"] = brokenRoot.string();
    rejected = false;
    try { run("project.save_state", wrongProjectSnapshot); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(run("project.state", {}) == stableState);
    run("command.undo", {});
    assert(run("project.state", {}).at("timeline") == stableProject.at("timeline"));
  }
  std::filesystem::remove_all(projectRoot);

  // Splits inside a fade retain the original timeline envelope, even at 200% speed.
  {
    ai_editor::EditorSession session;
    session.replaceState({{"mediaAssets", {{{"id", "fade_media"}, {"path", "fixture.mp4"}, {"kind", "video"}, {"metadata", {{"durationUs", 12'000'000}, {"hasAudio", true}}}}}},
      {"timeline", {{"tracks", {{{"id", "v1"}, {"kind", "video"}, {"clips", nlohmann::json::array()}}}}}}});
    auto run = [&](nlohmann::json command) { return session.executeCommand(command); };
    auto clips = [&]() { return session.timelineJson().at("tracks").at(0).at("clips"); };
    run({{"type", "add_clip"}, {"clipId", "original"}, {"mediaId", "fade_media"}, {"trackId", "v1"}, {"startUs", 1'000'000}, {"outUs", 8'000'000}, {"speedPercent", 200},
      {"transform", {{"fadeInUs", 2'000'000}, {"fadeOutUs", 2'000'000}}}, {"audio", {{"fadeInUs", 2'000'000}, {"fadeOutUs", 2'000'000}}}});
    const auto original = session.projectStateJson();
    run({{"type", "split_clip"}, {"clipId", "original"}, {"playheadUs", 2'000'000}});
    const auto rightId = clips().at(1).at("id").get<std::string>();
    assert(clips().at(0).at("audio").at("fadeDurationUs") == 4'000'000);
    assert(clips().at(1).at("transform").at("fadeOffsetUs") == 1'000'000);
    assert(clips().at(1).at("audio").at("fadeOffsetUs") == 1'000'000);
    session.undoCommand(); assert(session.projectStateJson() == original); session.redoCommand();
    run({{"type", "split_clip"}, {"clipId", rightId}, {"playheadUs", 4'000'000}});
    assert(clips().at(2).at("audio").at("fadeOffsetUs") == 3'000'000);
    assert(clips().at(2).at("transform").at("fadeDurationUs") == 4'000'000);
    const auto splitState = session.projectStateJson();
    ai_editor::EditorSession restored; restored.replaceState(splitState);
    assert(restored.timelineJson() == session.timelineJson());
    run({{"type", "apply_audio_adjustment"}, {"clipId", rightId}, {"adjustment", {{"gainDb", -6}}}});
    run({{"type", "apply_transform"}, {"clipId", rightId}, {"transform", {{"positionX", 50}}}});
    assert(clips().at(1).at("audio").at("fadeOffsetUs") == 1'000'000);
    assert(clips().at(1).at("transform").at("fadeOffsetUs") == 1'000'000);
    auto adjustment = clips().at(1).at("audio"); adjustment["fadeInUs"] = 500'000;
    run({{"type", "apply_audio_adjustment"}, {"clipId", rightId}, {"adjustment", adjustment}});
    assert(clips().at(1).at("audio").at("fadeDurationUs") == 0);
    assert(clips().at(1).at("transform").at("fadeOffsetUs") == 1'000'000);
    session.undoCommand();
    const auto stable = session.projectStateJson(); const auto history = session.commandHistoryJson();
    bool rejected = false;
    try { run({{"type", "apply_audio_adjustment"}, {"clipId", rightId}, {"adjustment", {{"fadeOffsetUs", 5'000'000}}}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected && session.projectStateJson() == stable && session.commandHistoryJson() == history);
    for (const auto& command : nlohmann::json::array({
      {{"type", "apply_clip_speed"}, {"clipId", rightId}, {"speedPercent", 100}},
      {{"type", "trim_clip"}, {"clipId", rightId}, {"edge", "end"}, {"timeUs", 5'000'000}},
      {{"type", "set_clip_source_range"}, {"clipId", rightId}, {"inUs", 3'000'000}, {"outUs", 7'000'000}}
    })) {
      run(command);
      assert(clips().at(1).at("audio").at("fadeDurationUs") == 0);
      assert(clips().at(1).at("transform").at("fadeDurationUs") == 0);
      session.undoCommand(); assert(session.projectStateJson() == stable);
    }
  }

  // Compound editing must preserve the full clip look and roll back data AND history.
  {
    ai_editor::EditorSession session;
    session.replaceState({
      {"mediaAssets", {{{"id", "regression_media"}, {"path", "fixture.mp4"}, {"kind", "video"}, {"metadata", {{"durationUs", 10'000'000}, {"hasAudio", true}}}}}},
      {"timeline", {{"tracks", {
        {{"id", "v1"}, {"kind", "video"}, {"clips", nlohmann::json::array()}},
        {{"id", "a1"}, {"kind", "audio"}, {"clips", nlohmann::json::array()}}
      }}}}
    });
    auto run = [&](nlohmann::json command) { return session.executeCommand(command); };
    auto state = [&]() { return session.timelineJson(); };
    run({{"type", "add_clip"}, {"clipId", "original"}, {"mediaId", "regression_media"}, {"trackId", "v1"}, {"startUs", 0}, {"outUs", 8'000'000}, {"speedPercent", 200},
         {"color", {{"brightness", 15}}}, {"transform", {{"opacity", 0.6}}}, {"audio", {{"gainDb", -4}}}});
    auto original = state().at("tracks").at(0).at("clips").at(0);
    assert(original.at("color").at("brightness") == 15);
    assert(original.at("transform").at("opacity") == 0.6);
    assert(original.at("audio").at("gainDb") == -4);
    const auto beforeBatch = state();
    const auto beforeHistory = session.commandHistoryJson();
    bool rejected = false;
    try {
      run({{"type", "execute_batch"}, {"commands", {
        {{"type", "move_clip"}, {"clipId", "original"}, {"trackId", "v1"}, {"startUs", 1'000'000}},
        {{"type", "move_clip"}, {"clipId", "missing"}, {"trackId", "v1"}, {"startUs", 0}}
      }}});
    } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(state() == beforeBatch);
    assert(session.commandHistoryJson() == beforeHistory);
    run({{"type", "execute_batch"}, {"commands", {
      {{"type", "split_clip"}, {"clipId", "original"}, {"playheadUs", 1'000'000}},
      {{"type", "apply_audio_adjustment"}, {"clipId", "original"}, {"adjustment", {{"gainDb", -12}}}}
    }}});
    assert(session.commandHistoryJson().at("undoCount").get<int>() == beforeHistory.at("undoCount").get<int>() + 1);
    assert(state().at("tracks").at(0).at("clips").size() == 2);
    assert(state().at("tracks").at(0).at("clips").at(0).at("outUs") == 2'000'000);
    session.undoCommand();
    assert(state() == beforeBatch);
    session.redoCommand();
    assert(state().at("tracks").at(0).at("clips").size() == 2);
    run({{"type", "update_track"}, {"trackId", "v1"}, {"locked", true}});
    const auto lockedState = state();
    const auto beforeRemove = session.projectStateJson();
    rejected = false;
    try { session.removeMedia({{"type", "remove_media"}, {"mediaId", "regression_media"}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(session.projectStateJson() == beforeRemove);
    for (auto command : nlohmann::json::array({
      {{"type", "split_clip"}, {"clipId", "original"}, {"playheadUs", 500'000}},
      {{"type", "apply_transform"}, {"clipId", "original"}, {"transform", {{"scale", 2}}}},
      {{"type", "apply_color_adjustment"}, {"clipId", "original"}, {"adjustment", {{"brightness", 10}}}},
      {{"type", "delete_track"}, {"trackId", "v1"}}
    })) {
      rejected = false;
      try { run(command); } catch (const std::exception&) { rejected = true; }
      assert(rejected);
      assert(state() == lockedState);
    }
    run({{"type", "update_track"}, {"trackId", "v1"}, {"locked", false}});
    const auto beforeTrim = state();
    rejected = false;
    try { run({{"type", "trim_clip"}, {"clipId", "original"}, {"edge", "end"}, {"timeUs", 12'000'000}}); }
    catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(state() == beforeTrim);
    const auto beforeSettings = session.projectStateJson();
    run({{"type", "update_project_settings"}, {"settings", {{"width", 640}, {"height", 360}, {"fps", 24}, {"masterGainDb", -8}}}});
    assert(session.projectStateJson().at("projectSettings").at("fps") == 24);
    assert(state().at("fps") == 24);
    session.undoCommand();
    assert(session.projectStateJson() == beforeSettings);
    session.redoCommand();
    const auto stableState = session.projectStateJson();
    const auto stableHistory = session.commandHistoryJson();
    auto invalidState = stableState;
    invalidState["timeline"]["tracks"][0]["clips"].push_back(invalidState["timeline"]["tracks"][0]["clips"][0]);
    rejected = false;
    try { session.replaceState(invalidState, false); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(session.projectStateJson() == stableState);
    assert(session.commandHistoryJson() == stableHistory);
    ai_editor::EditorSession reopened;
    reopened.openDatabase(session.sessionInfo().at("databasePath").get<std::string>());
    assert(reopened.timelineJson() == state());
    assert(reopened.projectStateJson().at("projectSettings") == stableState.at("projectSettings"));
    assert(reopened.timelineJson().at("fps") == 24);
    const auto beforeImport = session.projectStateJson();
    const auto beforeImportHistory = session.commandHistoryJson();
    rejected = false;
    try {
      const ai_editor::FfmpegLocator locator;
      session.importMedia({{"type", "import_media"}, {"paths", {sampleB, "unsupported.exe"}}}, ai_editor::FfprobeService{locator});
    } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    assert(session.projectStateJson() == beforeImport);
    assert(session.commandHistoryJson() == beforeImportHistory);
  }

  {
    ai_editor::EditorSession session;
    const auto captionDb = std::filesystem::absolute("captions-command-test.db");
    std::filesystem::remove(captionDb);
    session.openDatabase(captionDb.string());
    session.executeCommand({{"type", "add_title"}, {"titleId", "keep-title"}, {"text", "Opening title"}, {"startUs", 0}});
    const auto before = session.projectStateJson();
    const auto historyBefore = session.commandHistoryJson();
    const auto cues = nlohmann::json::array({{{"text", "First caption"}, {"startUs", 500'000}, {"durationUs", 1'000'000}}, {{"text", "Overlapping caption"}, {"startUs", 1'000'000}, {"durationUs", 2'000'000}}});
    session.executeCommand({{"type", "import_captions"}, {"captions", cues}});
    const auto imported = session.projectStateJson();
    assert(imported.at("timeline").at("titles").size() == 3);
    assert(imported.at("timeline").at("titles").at(1).at("kind") == "caption");
    assert(session.commandHistoryJson().at("undoCount").get<int>() == historyBefore.at("undoCount").get<int>() + 1);
    session.undoCommand(); assert(session.projectStateJson() == before);
    session.redoCommand(); assert(session.projectStateJson() == imported);
    auto invalid = cues; invalid[1]["durationUs"] = -1;
    const auto stableHistory = session.commandHistoryJson();
    bool rejected = false;
    try { session.executeCommand({{"type", "import_captions"}, {"mode", "replace"}, {"captions", invalid}}); } catch (const std::exception&) { rejected = true; }
    assert(rejected); assert(session.projectStateJson() == imported); assert(session.commandHistoryJson() == stableHistory);
    session.executeCommand({{"type", "import_captions"}, {"mode", "replace"}, {"captions", nlohmann::json::array({cues[0]})}, {"style", {{"fontSize", 28}, {"background", false}}}});
    const auto replaced = session.timelineJson().at("titles");
    assert(replaced.size() == 2); assert(replaced.at(0).at("id") == "keep-title"); assert(replaced.at(1).at("fontSize") == 28); assert(replaced.at(1).at("background") == false);
    session.undoCommand(); assert(session.projectStateJson() == imported);
    ai_editor::EditorSession reopened;
    reopened.openDatabase(captionDb.string());
    assert(reopened.timelineJson() == session.timelineJson());
  }

  {
    const ai_editor::FfmpegLocator locator;
    const ai_editor::FfprobeService probe{locator};
    ai_editor::EditorSession session;
    const auto project = mediaFixtures / "project";
    std::filesystem::create_directory(project);
    session.openDatabase(project / "project.db", {{"path", project.string()}, {"name", "Media recovery regression"}});
    const auto imported = session.importMedia({{"paths", {sampleA, sampleA}}, {"type", "import_media"}}, probe);
    assert(imported.at("data").at("media").size() == 1);
    const auto id = imported.at("data").at("media").at(0).at("id");
    session.executeCommand({{"type", "add_clip"}, {"clipId", "relink-clip"}, {"mediaId", id}, {"trackId", "v1"}, {"startUs", 0}, {"outUs", 8'000'000}});
    const auto before = session.projectStateJson();
    const auto history = session.commandHistoryJson();
    const auto corrupt = (mediaFixtures / "corrupt.mp4").string();
    { std::ofstream file(corrupt); file << "not a video"; }
    for (const auto& invalid : {corrupt, (mediaFixtures / "absent.mp4").string()}) {
      bool rejected = false;
      try { session.importMedia({{"type", "import_media"}, {"paths", {sampleB, invalid}}}, probe); } catch (const std::exception&) { rejected = true; }
      assert(rejected); assert(session.projectStateJson() == before); assert(session.commandHistoryJson() == history);
      rejected = false;
      try { session.relinkMedia({{"type", "relink_media"}, {"mediaId", id}, {"path", invalid}}, probe); } catch (const std::exception&) { rejected = true; }
      assert(rejected); assert(session.projectStateJson() == before); assert(session.commandHistoryJson() == history);
    }
    session.relinkMedia({{"type", "relink_media"}, {"mediaId", id}, {"path", sampleB}}, probe);
    const auto relinked = session.projectStateJson();
    assert(relinked.at("timeline") == before.at("timeline"));
    assert(relinked.at("mediaAssets").at(0).at("path") == sampleB);
    assert(relinked.at("mediaAssets").at(0).at("name") == "sample-a.bmp");
    assert(session.commandHistoryJson().at("undoCount").get<int>() == history.at("undoCount").get<int>() + 1);
    session.undoCommand(); assert(session.projectStateJson() == before);
    session.redoCommand(); assert(session.projectStateJson() == relinked);
    session.executeCommand({{"type", "update_track"}, {"trackId", "v1"}, {"locked", true}});
    bool rejected = false;
    try { session.relinkMedia({{"type", "relink_media"}, {"mediaId", id}, {"path", sampleA}}, probe); } catch (const std::exception&) { rejected = true; }
    assert(rejected);
    session.undoCommand();
    const auto copyResult = session.importMedia({{"type", "import_media"}, {"paths", {sampleA, sampleA}}, {"copyToProject", true}}, probe).at("data").at("media");
    assert(copyResult.size() == 1);
    const auto copied = copyResult.at(0);
    const auto copiedPath = std::filesystem::path(copied.at("path").get<std::string>());
    assert(copiedPath.parent_path() == project / "media");
    assert(std::filesystem::file_size(copiedPath) == std::filesystem::file_size(sampleA));
    assert(copied.at("name") == "sample-a.bmp");
    const auto beforeFailedCopy = session.projectStateJson();
    rejected = false;
    try { session.importMedia({{"type", "import_media"}, {"paths", {sampleB, corrupt}}, {"copyToProject", true}}, probe); } catch (const std::exception&) { rejected = true; }
    assert(rejected); assert(session.projectStateJson() == beforeFailedCopy);
    assert(std::distance(std::filesystem::directory_iterator(project / "media"), std::filesystem::directory_iterator{}) == 1);
    ai_editor::EditorSession reopened;
    reopened.openDatabase(project / "project.db");
    assert(reopened.projectStateJson().at("mediaAssets") == session.projectStateJson().at("mediaAssets"));
  }

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
