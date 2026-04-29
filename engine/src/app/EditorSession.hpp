#pragma once

#include "media/FfprobeService.hpp"
#include "timeline/TimelineService.hpp"

#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace ai_editor {

struct IndexedMedia {
  std::string id;
  std::string path;
  std::string name;
  std::string kind;
  std::string extension;
  std::string importedAt;
  nlohmann::json metadata = nlohmann::json::object();
  nlohmann::json intelligence = nlohmann::json::object();

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"id", id},
        {"path", path},
        {"name", name},
        {"kind", kind},
        {"extension", extension},
        {"importedAt", importedAt},
        {"metadata", metadata},
        {"intelligence", intelligence},
    };
  }
};

struct AiEditProposal {
  std::string id;
  std::string goal;
  std::string status = "pending";
  std::string explanation;
  nlohmann::json commands = nlohmann::json::array();
  std::string createdAt;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"id", id},
        {"goal", goal},
        {"status", status},
        {"explanation", explanation},
        {"commands", commands},
        {"createdAt", createdAt},
    };
  }
};

class EditorSession {
 public:
  EditorSession() : databasePath_(resolveDatabasePath()) {
    std::filesystem::create_directories(databasePath_.parent_path());
    if (sqlite3_open(databasePath_.string().c_str(), &db_) != SQLITE_OK) {
      const std::string message = db_ ? sqlite3_errmsg(db_) : "unknown sqlite error";
      sqlite3_close(db_);
      db_ = nullptr;
      throw std::runtime_error("failed to open editor session database: " + message);
    }
    initialize();
    load();
  }

  ~EditorSession() {
    if (db_) {
      sqlite3_close(db_);
    }
  }

  EditorSession(const EditorSession&) = delete;
  EditorSession& operator=(const EditorSession&) = delete;

  [[nodiscard]] nlohmann::json sessionInfo() const {
    return {
        {"databasePath", databasePath_.string()},
        {"mediaCount", media_.size()},
        {"proposalCount", proposals_.size()},
    };
  }

  [[nodiscard]] nlohmann::json timelineJson() const {
    return {
        {"id", timeline_.id},
        {"name", timeline_.name},
        {"fps", timeline_.fps},
        {"durationUs", timeline_.durationUs},
        {"tracks", tracksJson()},
    };
  }

  [[nodiscard]] nlohmann::json mediaIndexJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& media : media_) {
      rows.push_back(media.toJson());
    }
    return {{"media", rows}};
  }

  [[nodiscard]] nlohmann::json proposalsJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& proposal : proposals_) {
      rows.push_back(proposal.toJson());
    }
    return {{"proposals", rows}};
  }

  nlohmann::json importMedia(const nlohmann::json& command, const FfprobeService& ffprobeService) {
    if (!command.contains("paths") || !command.at("paths").is_array()) {
      throw std::runtime_error("import_media requires paths");
    }

    auto imported = nlohmann::json::array();
    for (const auto& item : command.at("paths")) {
      const auto path = item.get<std::string>();
      if (!isSupportedMediaPath(path)) {
        throw std::runtime_error("unsupported media type: " + path);
      }

      const auto id = mediaIdForPath(path);
      auto media = mediaById(id);
      if (!media) {
        media = IndexedMedia{};
        media->id = id;
      }

      media->path = path;
      media->name = fileName(path);
      media->extension = extensionForPath(path);
      media->kind = media->extension == "mp3" ? "audio" : "video";
      media->importedAt = nowStamp();
      media->metadata = probeOrFallback(path, media->kind, ffprobeService);
      media->intelligence = intelligenceFor(*media);
      upsertMedia(*media);
      imported.push_back(media->toJson());
    }

    saveMedia();
    return commandResult("import_media", {{"media", imported}, {"mediaIndex", mediaIndexJson()}, {"timeline", timelineJson()}});
  }

  nlohmann::json removeMedia(const nlohmann::json& command) {
    const auto mediaId = command.value("mediaId", std::string{});
    if (mediaId.empty()) {
      throw std::runtime_error("remove_media requires mediaId");
    }

    const auto media = findMedia(mediaId);
    if (!media) {
      throw std::runtime_error("media not found: " + mediaId);
    }

    media_.erase(std::remove_if(media_.begin(), media_.end(), [&](const IndexedMedia& item) {
                   return item.id == mediaId;
                 }),
                 media_.end());

    for (auto& track : timeline_.tracks) {
      track.clips.erase(std::remove_if(track.clips.begin(), track.clips.end(), [&](const Clip& clip) {
                          return clip.mediaId == mediaId;
                        }),
                        track.clips.end());
    }

    recalculateTimelineDuration();
    saveMedia();
    saveTimeline();
    return commandResult("remove_media", {{"mediaIndex", mediaIndexJson()}, {"timeline", timelineJson()}});
  }

  nlohmann::json executeCommand(const nlohmann::json& command) {
    const auto type = command.value("type", std::string{});
    if (type == "add_track") {
      addTrack(command);
    } else if (type == "add_clip") {
      addClip(command);
    } else if (type == "move_clip") {
      moveClip(command);
    } else if (type == "trim_clip") {
      trimClip(command);
    } else if (type == "split_clip") {
      splitClip(command);
    } else if (type == "delete_clip") {
      deleteClip(command);
    } else if (type == "ripple_delete_clip") {
      TimelineService::rippleDelete(timeline_, command.value("clipId", std::string{}));
    } else if (type == "delete_track") {
      deleteTrack(command);
    } else if (type == "apply_color_adjustment" || type == "apply_lut") {
      applyClipLook(command);
    } else if (type == "apply_audio_adjustment") {
      applyClipAudio(command);
    } else if (type == "apply_transform") {
      applyClipTransform(command);
    } else if (type == "apply_effect_stack") {
      applyClipEffects(command);
    } else {
      throw std::runtime_error("unknown command type: " + type);
    }

    recalculateTimelineDuration();
    saveTimeline();
    return commandResult(type, {{"timeline", timelineJson()}});
  }

  nlohmann::json generateProposal(const nlohmann::json& params) {
    const auto goal = params.value("goal", std::string{"make a 30 second rough cut"});
    auto selectedIds = readStringArray(params, "mediaIds");
    if (selectedIds.empty()) {
      for (const auto& media : media_) {
        if (media.kind == "video") {
          selectedIds.push_back(media.id);
        }
      }
    }

    if (selectedIds.empty()) {
      throw std::runtime_error("import or select video media before generating a rough cut");
    }

    const auto totalDurationUs = parseDurationFromGoalUs(goal);
    const auto segmentUs = std::max<std::int64_t>(1'000'000, totalDurationUs / static_cast<std::int64_t>(selectedIds.size()));
    std::int64_t cursorUs = 0;
    auto commands = nlohmann::json::array();

    for (std::size_t index = 0; index < selectedIds.size() && cursorUs < totalDurationUs; ++index) {
      const auto* media = findMedia(selectedIds.at(index));
      if (!media || media->kind != "video") {
        continue;
      }

      const auto mediaDuration = std::max<std::int64_t>(1'000'000, media->metadata.value("durationUs", 8'000'000LL));
      const auto outUs = std::min(mediaDuration, std::min(segmentUs, totalDurationUs - cursorUs));
      commands.push_back({
          {"type", "add_clip"},
          {"clipId", "proposal_clip_" + stableHash(idSeed() + media->id + std::to_string(index))},
          {"mediaId", media->id},
          {"trackId", "v1"},
          {"startUs", cursorUs},
          {"inUs", 0},
          {"outUs", outUs},
      });
      cursorUs += outUs;
    }

    if (commands.empty()) {
      throw std::runtime_error("rough cut proposal could not find usable video media");
    }

    AiEditProposal proposal;
    proposal.id = "proposal_" + stableHash(idSeed() + goal);
    proposal.goal = goal;
    proposal.status = "pending";
    proposal.createdAt = nowStamp();
    proposal.commands = commands;
    proposal.explanation = "Built a rough cut by laying selected clips onto Video 1 in sequence, targeting " +
                           std::to_string(totalDurationUs / 1'000'000) + " seconds while preserving the original media order.";
    upsertProposal(proposal);
    saveProposals();
    return proposal.toJson();
  }

  nlohmann::json applyProposal(const nlohmann::json& params) {
    const auto proposalId = params.value("proposalId", std::string{});
    auto proposal = proposalById(proposalId);
    if (!proposal) {
      throw std::runtime_error("proposal not found: " + proposalId);
    }
    if (proposal->status != "pending") {
      throw std::runtime_error("proposal is not pending: " + proposalId);
    }

    for (const auto& command : proposal->commands) {
      executeCommand(command);
    }
    proposal->status = "applied";
    upsertProposal(*proposal);
    saveProposals();
    return proposal->toJson();
  }

  nlohmann::json rejectProposal(const nlohmann::json& params) {
    const auto proposalId = params.value("proposalId", std::string{});
    auto proposal = proposalById(proposalId);
    if (!proposal) {
      throw std::runtime_error("proposal not found: " + proposalId);
    }
    proposal->status = "rejected";
    upsertProposal(*proposal);
    saveProposals();
    return proposal->toJson();
  }

 private:
  static std::filesystem::path resolveDatabasePath() {
    if (const auto* value = std::getenv("AI_VIDEO_SESSION_DB")) {
      if (std::string(value).size() > 0) {
        return std::filesystem::path(value);
      }
    }
#ifdef _WIN32
    if (const auto* value = std::getenv("LOCALAPPDATA")) {
      return std::filesystem::path(value) / "AI Video Editor" / "session" / "project.db";
    }
#else
    if (const auto* value = std::getenv("HOME")) {
      return std::filesystem::path(value) / ".ai-video-editor" / "session" / "project.db";
    }
#endif
    return std::filesystem::current_path() / ".ai-video-editor" / "session" / "project.db";
  }

  void initialize() {
    exec("PRAGMA journal_mode=WAL;");
    exec(R"sql(
      CREATE TABLE IF NOT EXISTS media_index (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        extension TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        intelligence_json TEXT NOT NULL
      );
    )sql");
    exec(R"sql(
      CREATE TABLE IF NOT EXISTS timeline_tracks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        track_index INTEGER NOT NULL,
        locked INTEGER NOT NULL,
        muted INTEGER NOT NULL,
        visible INTEGER NOT NULL
      );
    )sql");
    exec(R"sql(
      CREATE TABLE IF NOT EXISTS timeline_clips (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        start_us INTEGER NOT NULL,
        in_us INTEGER NOT NULL,
        out_us INTEGER NOT NULL,
        color_json TEXT NOT NULL,
        audio_json TEXT NOT NULL DEFAULT '{}',
        transform_json TEXT NOT NULL DEFAULT '{}',
        effects_json TEXT NOT NULL DEFAULT '[]'
      );
    )sql");
    ensureColumn("timeline_clips", "audio_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("timeline_clips", "transform_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("timeline_clips", "effects_json", "TEXT NOT NULL DEFAULT '[]'");
    exec(R"sql(
      CREATE TABLE IF NOT EXISTS ai_proposals (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        explanation TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    )sql");
  }

  void load() {
    loadMedia();
    loadTracks();
    loadClips();
    loadProposals();
    if (timeline_.tracks.empty()) {
      timeline_.tracks = defaultTracks();
      saveTimeline();
    }
    recalculateTimelineDuration();
  }

  void loadMedia() {
    sqlite3_stmt* statement = nullptr;
    prepare("SELECT id,path,name,kind,extension,imported_at,metadata_json,intelligence_json FROM media_index ORDER BY imported_at ASC;", &statement);
    while (sqlite3_step(statement) == SQLITE_ROW) {
      IndexedMedia media;
      media.id = columnText(statement, 0);
      media.path = columnText(statement, 1);
      media.name = columnText(statement, 2);
      media.kind = columnText(statement, 3);
      media.extension = columnText(statement, 4);
      media.importedAt = columnText(statement, 5);
      media.metadata = parseJson(columnText(statement, 6), nlohmann::json::object());
      media.intelligence = parseJson(columnText(statement, 7), nlohmann::json::object());
      media_.push_back(media);
    }
    sqlite3_finalize(statement);
  }

  void loadTracks() {
    sqlite3_stmt* statement = nullptr;
    prepare("SELECT id,name,kind,track_index,locked,muted,visible FROM timeline_tracks ORDER BY track_index ASC;", &statement);
    while (sqlite3_step(statement) == SQLITE_ROW) {
      Track track;
      track.id = columnText(statement, 0);
      track.name = columnText(statement, 1);
      track.kind = columnText(statement, 2) == "audio" ? TrackKind::Audio : TrackKind::Video;
      track.index = sqlite3_column_int(statement, 3);
      track.locked = sqlite3_column_int(statement, 4) != 0;
      track.muted = sqlite3_column_int(statement, 5) != 0;
      track.visible = sqlite3_column_int(statement, 6) != 0;
      timeline_.tracks.push_back(track);
    }
    sqlite3_finalize(statement);
  }

  void loadClips() {
    sqlite3_stmt* statement = nullptr;
    prepare("SELECT id,media_id,track_id,start_us,in_us,out_us,color_json,audio_json,transform_json,effects_json FROM timeline_clips ORDER BY start_us ASC;", &statement);
    while (sqlite3_step(statement) == SQLITE_ROW) {
      Clip clip;
      clip.id = columnText(statement, 0);
      clip.mediaId = columnText(statement, 1);
      clip.trackId = columnText(statement, 2);
      clip.startUs = sqlite3_column_int64(statement, 3);
      clip.inUs = sqlite3_column_int64(statement, 4);
      clip.outUs = sqlite3_column_int64(statement, 5);
      const auto color = parseJson(columnText(statement, 6), defaultColorJson());
      clip.color.brightness = color.value("brightness", 0.0);
      clip.color.contrast = color.value("contrast", 0.0);
      clip.color.saturation = color.value("saturation", 1.0);
      clip.color.temperature = color.value("temperature", 0.0);
      clip.color.tint = color.value("tint", 0.0);
      clip.color.lutId = color.value("lutId", std::string{});
      clip.color.lutStrength = color.value("lutStrength", 1.0);
      const auto audio = parseJson(columnText(statement, 7), defaultAudioJson());
      clip.audioGainDb = audio.value("gainDb", 0.0);
      clip.audioMuted = audio.value("muted", false);
      clip.audioFadeInUs = audio.value("fadeInUs", 0LL);
      clip.audioFadeOutUs = audio.value("fadeOutUs", 0LL);
      clip.audioNormalize = audio.value("normalize", false);
      clip.audioCleanup = audio.value("cleanup", false);
      clip.transform = transformFromJson(parseJson(columnText(statement, 8), defaultTransformJson()));
      clip.effects = effectsFromJson(parseJson(columnText(statement, 9), defaultEffectsJson()));
      auto* track = findTrack(clip.trackId);
      if (track) {
        track->clips.push_back(clip);
      }
    }
    sqlite3_finalize(statement);
  }

  void loadProposals() {
    sqlite3_stmt* statement = nullptr;
    prepare("SELECT id,goal,status,explanation,commands_json,created_at FROM ai_proposals ORDER BY created_at DESC;", &statement);
    while (sqlite3_step(statement) == SQLITE_ROW) {
      AiEditProposal proposal;
      proposal.id = columnText(statement, 0);
      proposal.goal = columnText(statement, 1);
      proposal.status = columnText(statement, 2);
      proposal.explanation = columnText(statement, 3);
      proposal.commands = parseJson(columnText(statement, 4), nlohmann::json::array());
      proposal.createdAt = columnText(statement, 5);
      proposals_.push_back(proposal);
    }
    sqlite3_finalize(statement);
  }

  void saveMedia() {
    exec("DELETE FROM media_index;");
    for (const auto& media : media_) {
      sqlite3_stmt* statement = nullptr;
      prepare("INSERT INTO media_index(id,path,name,kind,extension,imported_at,metadata_json,intelligence_json) VALUES(?,?,?,?,?,?,?,?);", &statement);
      bindText(statement, 1, media.id);
      bindText(statement, 2, media.path);
      bindText(statement, 3, media.name);
      bindText(statement, 4, media.kind);
      bindText(statement, 5, media.extension);
      bindText(statement, 6, media.importedAt);
      bindText(statement, 7, media.metadata.dump());
      bindText(statement, 8, media.intelligence.dump());
      stepDone(statement);
    }
  }

  void saveTimeline() {
    exec("DELETE FROM timeline_clips;");
    exec("DELETE FROM timeline_tracks;");
    for (const auto& track : timeline_.tracks) {
      sqlite3_stmt* statement = nullptr;
      prepare("INSERT INTO timeline_tracks(id,name,kind,track_index,locked,muted,visible) VALUES(?,?,?,?,?,?,?);", &statement);
      bindText(statement, 1, track.id);
      bindText(statement, 2, track.name);
      bindText(statement, 3, track.kind == TrackKind::Audio ? "audio" : "video");
      sqlite3_bind_int(statement, 4, track.index);
      sqlite3_bind_int(statement, 5, track.locked ? 1 : 0);
      sqlite3_bind_int(statement, 6, track.muted ? 1 : 0);
      sqlite3_bind_int(statement, 7, track.visible ? 1 : 0);
      stepDone(statement);

      for (const auto& clip : track.clips) {
        sqlite3_stmt* clipStatement = nullptr;
        prepare("INSERT INTO timeline_clips(id,media_id,track_id,start_us,in_us,out_us,color_json,audio_json,transform_json,effects_json) VALUES(?,?,?,?,?,?,?,?,?,?);", &clipStatement);
        bindText(clipStatement, 1, clip.id);
        bindText(clipStatement, 2, clip.mediaId);
        bindText(clipStatement, 3, clip.trackId);
        sqlite3_bind_int64(clipStatement, 4, clip.startUs);
        sqlite3_bind_int64(clipStatement, 5, clip.inUs);
        sqlite3_bind_int64(clipStatement, 6, clip.outUs);
        bindText(clipStatement, 7, colorJson(clip).dump());
        bindText(clipStatement, 8, audioJson(clip).dump());
        bindText(clipStatement, 9, transformJson(clip.transform).dump());
        bindText(clipStatement, 10, effectsJson(clip.effects).dump());
        stepDone(clipStatement);
      }
    }
  }

  void saveProposals() {
    exec("DELETE FROM ai_proposals;");
    for (const auto& proposal : proposals_) {
      sqlite3_stmt* statement = nullptr;
      prepare("INSERT INTO ai_proposals(id,goal,status,explanation,commands_json,created_at) VALUES(?,?,?,?,?,?);", &statement);
      bindText(statement, 1, proposal.id);
      bindText(statement, 2, proposal.goal);
      bindText(statement, 3, proposal.status);
      bindText(statement, 4, proposal.explanation);
      bindText(statement, 5, proposal.commands.dump());
      bindText(statement, 6, proposal.createdAt);
      stepDone(statement);
    }
  }

  void addTrack(const nlohmann::json& command) {
    const auto kind = command.value("kind", std::string{"video"});
    Track track;
    track.kind = kind == "audio" ? TrackKind::Audio : TrackKind::Video;
    track.index = static_cast<int>(timeline_.tracks.size());
    track.id = command.value("trackId", std::string{kind.substr(0, 1) + std::to_string(track.index + 1)});
    track.name = command.value("name", std::string{kind == "audio" ? "Audio " : "Video "} + std::to_string(track.index + 1));
    timeline_.tracks.push_back(track);
  }

  void deleteTrack(const nlohmann::json& command) {
    const auto trackId = command.value("trackId", std::string{});
    timeline_.tracks.erase(std::remove_if(timeline_.tracks.begin(), timeline_.tracks.end(), [&](const Track& track) {
                             return track.id == trackId;
                           }),
                           timeline_.tracks.end());
  }

  void addClip(const nlohmann::json& command) {
    auto* track = findTrack(command.value("trackId", std::string{}));
    if (!track) {
      throw std::runtime_error("add_clip target track not found");
    }

    const auto mediaId = command.value("mediaId", std::string{});
    const auto* media = findMedia(mediaId);
    if (!media) {
      throw std::runtime_error("add_clip media not found: " + mediaId);
    }

    Clip clip;
    clip.id = command.value("clipId", std::string{"clip_" + stableHash(idSeed() + mediaId + std::to_string(track->clips.size()))});
    clip.mediaId = mediaId;
    clip.trackId = track->id;
    clip.startUs = command.value("startUs", 0LL);
    clip.inUs = command.value("inUs", 0LL);
    clip.outUs = command.value("outUs", std::max(clip.inUs + 1'000'000, media->metadata.value("durationUs", 8'000'000LL)));
    track->clips.erase(std::remove_if(track->clips.begin(), track->clips.end(), [&](const Clip& existing) {
                         return existing.id == clip.id;
                       }),
                       track->clips.end());
    track->clips.push_back(clip);
    sortTrack(*track);
  }

  void moveClip(const nlohmann::json& command) {
    auto clip = removeClip(command.value("clipId", std::string{}));
    clip.trackId = command.value("trackId", clip.trackId);
    clip.startUs = command.value("startUs", clip.startUs);
    auto* track = findTrack(clip.trackId);
    if (!track) {
      throw std::runtime_error("move_clip target track not found");
    }
    track->clips.push_back(clip);
    sortTrack(*track);
  }

  void trimClip(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("trim_clip clip not found");
    }
    const auto edge = command.value("edge", std::string{"end"});
    const auto timeUs = command.value("timeUs", edge == "start" ? clip->startUs : clip->outUs);
    if (edge == "start") {
      const auto deltaUs = std::max<std::int64_t>(0, timeUs) - clip->startUs;
      clip->startUs = std::max<std::int64_t>(0, timeUs);
      clip->inUs = std::max<std::int64_t>(0, clip->inUs + deltaUs);
    } else {
      clip->outUs = std::max<std::int64_t>(clip->inUs + 250'000, timeUs);
    }
  }

  void splitClip(const nlohmann::json& command) {
    const auto playheadUs = command.value("playheadUs", 0LL);
    Clip* clip = nullptr;
    if (command.contains("clipId")) {
      clip = findClip(command.value("clipId", std::string{}));
    } else {
      clip = findClipAt(playheadUs);
    }
    if (!clip) {
      return;
    }
    if (playheadUs <= clip->startUs || playheadUs >= clip->startUs + (clip->outUs - clip->inUs)) {
      return;
    }

    const auto firstOutUs = clip->inUs + (playheadUs - clip->startUs);
    Clip second = *clip;
    second.id = "clip_" + stableHash(idSeed() + clip->id + "split");
    second.startUs = playheadUs;
    second.inUs = firstOutUs;
    clip->outUs = firstOutUs;
    auto* track = findTrack(second.trackId);
    if (track) {
      track->clips.push_back(second);
      sortTrack(*track);
    }
  }

  void deleteClip(const nlohmann::json& command) {
    (void)removeClip(command.value("clipId", std::string{}));
  }

  void applyClipLook(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    if (command.contains("adjustment")) {
      const auto adjustment = command.at("adjustment");
      clip->color.brightness = adjustment.value("brightness", clip->color.brightness);
      clip->color.contrast = adjustment.value("contrast", clip->color.contrast);
      clip->color.saturation = adjustment.value("saturation", clip->color.saturation);
      clip->color.temperature = adjustment.value("temperature", clip->color.temperature);
      clip->color.tint = adjustment.value("tint", clip->color.tint);
    }
    if (command.contains("lutId")) {
      if (command.at("lutId").is_null()) {
        clip->color.lutId.clear();
      } else {
        clip->color.lutId = command.at("lutId").get<std::string>();
      }
      clip->color.lutStrength = command.value("strength", clip->color.lutStrength);
    }
  }

  void applyClipAudio(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    if (command.contains("adjustment")) {
      const auto adjustment = command.at("adjustment");
      clip->audioGainDb = adjustment.value("gainDb", clip->audioGainDb);
      clip->audioMuted = adjustment.value("muted", clip->audioMuted);
      clip->audioFadeInUs = adjustment.value("fadeInUs", clip->audioFadeInUs);
      clip->audioFadeOutUs = adjustment.value("fadeOutUs", clip->audioFadeOutUs);
      clip->audioNormalize = adjustment.value("normalize", clip->audioNormalize);
      clip->audioCleanup = adjustment.value("cleanup", clip->audioCleanup);
    }
  }

  void applyClipTransform(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    if (command.contains("transform")) {
      const auto transform = command.at("transform");
      clip->transform.enabled = transform.value("enabled", clip->transform.enabled);
      clip->transform.scale = transform.value("scale", clip->transform.scale);
      clip->transform.positionX = transform.value("positionX", clip->transform.positionX);
      clip->transform.positionY = transform.value("positionY", clip->transform.positionY);
      clip->transform.rotation = transform.value("rotation", clip->transform.rotation);
      clip->transform.opacity = transform.value("opacity", clip->transform.opacity);
    }
  }

  void applyClipEffects(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    if (command.contains("effects")) {
      clip->effects = effectsFromJson(command.at("effects"));
    }
  }

  [[nodiscard]] nlohmann::json tracksJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& track : timeline_.tracks) {
      auto clips = nlohmann::json::array();
      for (const auto& clip : track.clips) {
        clips.push_back({
            {"id", clip.id},
            {"mediaId", clip.mediaId},
            {"trackId", clip.trackId},
            {"startUs", clip.startUs},
            {"inUs", clip.inUs},
            {"outUs", clip.outUs},
            {"color", colorJson(clip)},
            {"audio", audioJson(clip)},
            {"transform", transformJson(clip.transform)},
            {"effects", effectsJson(clip.effects)},
            {"lut", clip.color.lutId.empty() ? nlohmann::json(nullptr) : nlohmann::json{{"lutId", clip.color.lutId}, {"strength", clip.color.lutStrength}}},
        });
      }
      rows.push_back({
          {"id", track.id},
          {"name", track.name},
          {"kind", track.kind == TrackKind::Audio ? "audio" : "video"},
          {"index", track.index},
          {"locked", track.locked},
          {"muted", track.muted},
          {"visible", track.visible},
          {"clips", clips},
      });
    }
    return rows;
  }

  [[nodiscard]] static std::vector<Track> defaultTracks() {
    return {
        {"v2", "Video 2", TrackKind::Video, 0, false, false, true, {}},
        {"v1", "Video 1", TrackKind::Video, 1, false, false, true, {}},
        {"a1", "Audio 1", TrackKind::Audio, 2, false, false, true, {}},
    };
  }

  [[nodiscard]] nlohmann::json commandResult(const std::string& type, nlohmann::json data) const {
    return {
        {"ok", true},
        {"commandId", type + "_" + stableHash(idSeed())},
        {"data", data},
    };
  }

  void recalculateTimelineDuration() {
    std::int64_t duration = 0;
    for (const auto& track : timeline_.tracks) {
      for (const auto& clip : track.clips) {
        duration = std::max(duration, clip.startUs + (clip.outUs - clip.inUs));
      }
    }
    timeline_.durationUs = std::max<std::int64_t>(60'000'000, duration + 5'000'000);
  }

  [[nodiscard]] IndexedMedia* findMedia(const std::string& id) {
    const auto item = std::find_if(media_.begin(), media_.end(), [&](const IndexedMedia& media) { return media.id == id; });
    return item == media_.end() ? nullptr : &(*item);
  }

  [[nodiscard]] const IndexedMedia* findMedia(const std::string& id) const {
    const auto item = std::find_if(media_.begin(), media_.end(), [&](const IndexedMedia& media) { return media.id == id; });
    return item == media_.end() ? nullptr : &(*item);
  }

  [[nodiscard]] std::optional<IndexedMedia> mediaById(const std::string& id) const {
    const auto* media = findMedia(id);
    if (media) {
      return *media;
    }
    return std::nullopt;
  }

  void upsertMedia(const IndexedMedia& media) {
    auto* existing = findMedia(media.id);
    if (existing) {
      *existing = media;
    } else {
      media_.push_back(media);
    }
  }

  [[nodiscard]] Track* findTrack(const std::string& id) {
    const auto item = std::find_if(timeline_.tracks.begin(), timeline_.tracks.end(), [&](const Track& track) { return track.id == id; });
    return item == timeline_.tracks.end() ? nullptr : &(*item);
  }

  [[nodiscard]] Clip* findClip(const std::string& id) {
    for (auto& track : timeline_.tracks) {
      auto item = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& clip) { return clip.id == id; });
      if (item != track.clips.end()) {
        return &(*item);
      }
    }
    return nullptr;
  }

  [[nodiscard]] Clip* findClipAt(std::int64_t playheadUs) {
    for (auto& track : timeline_.tracks) {
      for (auto& clip : track.clips) {
        if (playheadUs > clip.startUs && playheadUs < clip.startUs + (clip.outUs - clip.inUs)) {
          return &clip;
        }
      }
    }
    return nullptr;
  }

  Clip removeClip(const std::string& id) {
    for (auto& track : timeline_.tracks) {
      auto item = std::find_if(track.clips.begin(), track.clips.end(), [&](const Clip& clip) { return clip.id == id; });
      if (item != track.clips.end()) {
        auto clip = *item;
        track.clips.erase(item);
        return clip;
      }
    }
    throw std::runtime_error("clip not found: " + id);
  }

  [[nodiscard]] std::optional<AiEditProposal> proposalById(const std::string& id) const {
    const auto item = std::find_if(proposals_.begin(), proposals_.end(), [&](const AiEditProposal& proposal) { return proposal.id == id; });
    if (item != proposals_.end()) {
      return *item;
    }
    return std::nullopt;
  }

  void upsertProposal(const AiEditProposal& proposal) {
    auto item = std::find_if(proposals_.begin(), proposals_.end(), [&](const AiEditProposal& existing) { return existing.id == proposal.id; });
    if (item != proposals_.end()) {
      *item = proposal;
    } else {
      proposals_.push_back(proposal);
    }
  }

  static void sortTrack(Track& track) {
    std::sort(track.clips.begin(), track.clips.end(), [](const Clip& left, const Clip& right) {
      return left.startUs < right.startUs;
    });
  }

  static nlohmann::json colorJson(const Clip& clip) {
    return {
        {"brightness", clip.color.brightness},
        {"contrast", clip.color.contrast},
        {"saturation", clip.color.saturation},
        {"temperature", clip.color.temperature},
        {"tint", clip.color.tint},
        {"lutId", clip.color.lutId},
        {"lutStrength", clip.color.lutStrength},
    };
  }

  static nlohmann::json audioJson(const Clip& clip) {
    return {
        {"gainDb", clip.audioGainDb},
        {"muted", clip.audioMuted},
        {"fadeInUs", clip.audioFadeInUs},
        {"fadeOutUs", clip.audioFadeOutUs},
        {"normalize", clip.audioNormalize},
        {"cleanup", clip.audioCleanup},
    };
  }

  static nlohmann::json transformJson(const ClipTransform& transform) {
    return {
        {"enabled", transform.enabled},
        {"scale", transform.scale},
        {"positionX", transform.positionX},
        {"positionY", transform.positionY},
        {"rotation", transform.rotation},
        {"opacity", transform.opacity},
    };
  }

  static ClipTransform transformFromJson(const nlohmann::json& value) {
    ClipTransform transform;
    transform.enabled = value.value("enabled", true);
    transform.scale = value.value("scale", 1.0);
    transform.positionX = value.value("positionX", 0.0);
    transform.positionY = value.value("positionY", 0.0);
    transform.rotation = value.value("rotation", 0.0);
    transform.opacity = value.value("opacity", 1.0);
    return transform;
  }

  static nlohmann::json effectsJson(const std::vector<ClipEffect>& effects) {
    auto rows = nlohmann::json::array();
    for (const auto& effect : effects) {
      rows.push_back({
          {"id", effect.id},
          {"type", effect.type},
          {"label", effect.label},
          {"enabled", effect.enabled},
          {"amount", effect.amount},
      });
    }
    return rows;
  }

  static std::vector<ClipEffect> effectsFromJson(const nlohmann::json& value) {
    std::vector<ClipEffect> effects;
    if (!value.is_array()) {
      return effects;
    }
    for (const auto& item : value) {
      ClipEffect effect;
      effect.id = item.value("id", std::string{});
      effect.type = item.value("type", std::string{});
      effect.label = item.value("label", effect.type);
      effect.enabled = item.value("enabled", false);
      effect.amount = item.value("amount", 0.0);
      if (!effect.id.empty() && !effect.type.empty()) {
        effects.push_back(effect);
      }
    }
    return effects;
  }

  static nlohmann::json defaultColorJson() {
    return {{"brightness", 0}, {"contrast", 0}, {"saturation", 1}, {"temperature", 0}, {"tint", 0}, {"lutId", ""}, {"lutStrength", 1}};
  }

  static nlohmann::json defaultAudioJson() {
    return {{"gainDb", 0}, {"muted", false}, {"fadeInUs", 0}, {"fadeOutUs", 0}, {"normalize", false}, {"cleanup", false}};
  }

  static nlohmann::json defaultTransformJson() {
    return {{"enabled", true}, {"scale", 1}, {"positionX", 0}, {"positionY", 0}, {"rotation", 0}, {"opacity", 1}};
  }

  static nlohmann::json defaultEffectsJson() {
    return nlohmann::json::array();
  }

  static nlohmann::json probeOrFallback(const std::string& path, const std::string& kind, const FfprobeService& ffprobeService) {
    try {
      return ffprobeService.probe(path).toJson();
    } catch (...) {
      return {
          {"path", path},
          {"width", 0},
          {"height", 0},
          {"fps", 0.0},
          {"durationUs", kind == "audio" ? 12'000'000 : 8'000'000},
          {"codec", "unknown"},
          {"pixelFormat", "unknown"},
          {"colorTransfer", "unknown"},
          {"hdr", false},
          {"hasAudio", kind == "audio"},
      };
    }
  }

  static nlohmann::json intelligenceFor(const IndexedMedia& media) {
    const auto durationUs = media.metadata.value("durationUs", 0LL);
    return {
        {"summary",
         {
             {"durationUs", durationUs},
             {"codec", media.metadata.value("codec", std::string{"unknown"})},
             {"resolution", {{"width", media.metadata.value("width", 0)}, {"height", media.metadata.value("height", 0)}}},
             {"fps", media.metadata.value("fps", 0.0)},
             {"hdr", media.metadata.value("hdr", false)},
             {"hasAudio", media.metadata.value("hasAudio", false) || media.kind == "audio"},
         }},
        {"thumbnails", {{"status", media.kind == "video" ? "ready-on-demand" : "not-applicable"}}},
        {"previewFrames", {{"status", media.kind == "video" ? "ready-on-demand" : "not-applicable"}}},
        {"transcript", {{"status", "placeholder"}, {"text", ""}, {"language", "unknown"}}},
        {"sceneCuts", {{"status", "placeholder"}, {"cuts", nlohmann::json::array()}}},
    };
  }

  static std::vector<std::string> readStringArray(const nlohmann::json& value, const std::string& key) {
    std::vector<std::string> rows;
    if (!value.contains(key) || !value.at(key).is_array()) {
      return rows;
    }
    for (const auto& item : value.at(key)) {
      rows.push_back(item.get<std::string>());
    }
    return rows;
  }

  static std::int64_t parseDurationFromGoalUs(const std::string& goal) {
    std::optional<int> lastNumber;
    for (std::size_t index = 0; index < goal.size();) {
      if (!std::isdigit(static_cast<unsigned char>(goal.at(index)))) {
        ++index;
        continue;
      }
      int value = 0;
      while (index < goal.size() && std::isdigit(static_cast<unsigned char>(goal.at(index)))) {
        value = value * 10 + (goal.at(index) - '0');
        ++index;
      }
      lastNumber = value;
    }
    const auto seconds = std::clamp(lastNumber.value_or(30), 5, 600);
    return static_cast<std::int64_t>(seconds) * 1'000'000;
  }

  static bool isSupportedMediaPath(const std::string& path) {
    const auto extension = extensionForPath(path);
    return extension == "mp4" || extension == "mov" || extension == "mkv" || extension == "mp3";
  }

  static std::string extensionForPath(const std::string& path) {
    auto extension = std::filesystem::path(path).extension().string();
    if (!extension.empty() && extension.front() == '.') {
      extension.erase(extension.begin());
    }
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char value) {
      return static_cast<char>(std::tolower(value));
    });
    return extension;
  }

  static std::string fileName(const std::string& path) {
    const auto name = std::filesystem::path(path).filename().string();
    return name.empty() ? path : name;
  }

  static std::string mediaIdForPath(const std::string& path) {
    return "media_" + stableHash(path);
  }

  static std::string stableHash(const std::string& value) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (const auto character : value) {
      hash ^= static_cast<unsigned char>(character);
      hash *= 1099511628211ULL;
    }
    std::ostringstream stream;
    stream << std::hex << hash;
    return stream.str();
  }

  static std::string idSeed() {
    return std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
  }

  static std::string nowStamp() {
    return std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
  }

  static nlohmann::json parseJson(const std::string& value, const nlohmann::json& fallback) {
    try {
      return nlohmann::json::parse(value);
    } catch (...) {
      return fallback;
    }
  }

  void exec(const char* sql) {
    char* error = nullptr;
    if (sqlite3_exec(db_, sql, nullptr, nullptr, &error) != SQLITE_OK) {
      const std::string message = error ? error : "unknown sqlite error";
      sqlite3_free(error);
      throw std::runtime_error("sqlite error: " + message);
    }
  }

  void ensureColumn(const std::string& table, const std::string& column, const std::string& definition) {
    sqlite3_stmt* statement = nullptr;
    const auto sql = "PRAGMA table_info(" + table + ");";
    prepare(sql.c_str(), &statement);
    bool exists = false;
    while (sqlite3_step(statement) == SQLITE_ROW) {
      if (columnText(statement, 1) == column) {
        exists = true;
        break;
      }
    }
    sqlite3_finalize(statement);

    if (!exists) {
      const auto alter = "ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition + ";";
      exec(alter.c_str());
    }
  }

  void prepare(const char* sql, sqlite3_stmt** statement) {
    if (sqlite3_prepare_v2(db_, sql, -1, statement, nullptr) != SQLITE_OK) {
      throw std::runtime_error("sqlite prepare failed: " + std::string(sqlite3_errmsg(db_)));
    }
  }

  static void bindText(sqlite3_stmt* statement, int index, const std::string& value) {
    sqlite3_bind_text(statement, index, value.c_str(), -1, SQLITE_TRANSIENT);
  }

  void stepDone(sqlite3_stmt* statement) {
    if (sqlite3_step(statement) != SQLITE_DONE) {
      const std::string message = sqlite3_errmsg(db_);
      sqlite3_finalize(statement);
      throw std::runtime_error("sqlite step failed: " + message);
    }
    sqlite3_finalize(statement);
  }

  static std::string columnText(sqlite3_stmt* statement, int column) {
    const auto* value = sqlite3_column_text(statement, column);
    return value ? reinterpret_cast<const char*>(value) : "";
  }

  sqlite3* db_ = nullptr;
  std::filesystem::path databasePath_;
  Timeline timeline_;
  std::vector<IndexedMedia> media_;
  std::vector<AiEditProposal> proposals_;
};

}  // namespace ai_editor
