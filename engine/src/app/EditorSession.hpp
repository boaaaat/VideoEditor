#pragma once

#include "commands/CommandHistory.hpp"
#include "media/FfprobeService.hpp"
#include "timeline/TimelineService.hpp"

#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <iomanip>
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
  EditorSession() { openDatabase(resolveDatabasePath()); }

  ~EditorSession() {
    closeDatabase();
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

  void openDatabase(const std::filesystem::path& databasePath, const nlohmann::json& project = nullptr) {
    // Keep the current connection and its undo history until the destination is fully loaded.
    EditorSession candidate(nullptr);
    candidate.databasePath_ = databasePath;
    candidate.projectSettings_ = defaultProjectSettingsJson();
    candidate.savedAt_ = nowStamp();
    std::filesystem::create_directories(databasePath.parent_path());
    const auto utf8Path = databasePath.u8string();
    if (sqlite3_open(reinterpret_cast<const char*>(utf8Path.c_str()), &candidate.db_) != SQLITE_OK) {
      const std::string message = candidate.db_ ? sqlite3_errmsg(candidate.db_) : "unknown sqlite error";
      throw std::runtime_error("failed to open editor session database: " + message);
    }
    candidate.exec("PRAGMA journal_mode=WAL;");
    candidate.exec("SAVEPOINT open_project;");
    candidate.initialize();
    candidate.load();
    if (project.is_object()) {
      candidate.setActiveProject(project);
      const auto root = std::filesystem::path(project.value("path", std::string{}));
      bool resolvedMedia = false;
      for (auto& media : candidate.media_) {
        const auto path = std::filesystem::path(media.path);
        if (!root.empty() && !path.empty() && path.is_relative() && media.path.find("://") == std::string::npos) {
          media.path = (root / path).lexically_normal().string();
          if (media.metadata.is_object()) media.metadata["path"] = media.path;
          resolvedMedia = true;
        }
      }
      if (resolvedMedia) candidate.saveMedia();
      candidate.saveProjectMetadata();
    }
    candidate.exec("RELEASE open_project;");
    using std::swap;
    swap(db_, candidate.db_);
    swap(databasePath_, candidate.databasePath_);
    swap(media_, candidate.media_);
    swap(timeline_, candidate.timeline_);
    swap(proposals_, candidate.proposals_);
    swap(history_, candidate.history_);
    swap(projectSettings_, candidate.projectSettings_);
    swap(activeProject_, candidate.activeProject_);
    swap(savedAt_, candidate.savedAt_);
  }

  void setActiveProject(nlohmann::json project) {
    if (!activeProject_.is_object()) {
      activeProject_ = nlohmann::json::object();
    }
    for (auto& [key, value] : project.items()) {
      if (value.is_string() && value.get<std::string>().empty() && activeProject_.contains(key)) {
        continue;
      }
      activeProject_[key] = value;
    }
  }

  void saveProjectMetadata() {
    saveAppState();
  }

  [[nodiscard]] nlohmann::json timelineJson() const {
    return {
        {"id", timeline_.id},
        {"name", timeline_.name},
        {"fps", timeline_.fps},
        {"durationUs", timeline_.durationUs},
        {"tracks", tracksJson()},
        {"markers", markersJson()},
        {"titles", timeline_.titles},
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

  [[nodiscard]] nlohmann::json projectStateJson() const {
    return {
        {"version", 1},
        {"savedAt", savedAt_},
        {"project", activeProject_},
        {"projectSettings", projectSettings_},
        {"mediaAssets", mediaRowsJson()},
        {"timeline", timelineJson()},
        {"aiProposals", proposalRowsJson()},
    };
  }

  void replaceState(const nlohmann::json& state, bool resetHistory = true) {
    const auto originalMedia = media_;
    const auto originalTimeline = timeline_;
    const auto originalProposals = proposals_;
    const auto originalHistory = history_;
    const auto originalSettings = projectSettings_;
    const auto originalProject = activeProject_;
    const auto originalSavedAt = savedAt_;
    exec("SAVEPOINT replace_state;");
    try {
      replaceStateImpl(state, resetHistory);
      exec("RELEASE replace_state;");
    } catch (...) {
      media_ = originalMedia;
      timeline_ = originalTimeline;
      proposals_ = originalProposals;
      history_ = originalHistory;
      projectSettings_ = originalSettings;
      activeProject_ = originalProject;
      savedAt_ = originalSavedAt;
      exec("ROLLBACK TO replace_state;");
      exec("RELEASE replace_state;");
      throw;
    }
  }

  void replaceStateImpl(const nlohmann::json& state, bool resetHistory) {
    media_.clear();
    timeline_ = Timeline{};
    proposals_.clear();
    if (resetHistory) {
      history_.clear();
    }
    savedAt_ = state.value("savedAt", nowStamp());

    if (state.contains("project") && state.at("project").is_object()) {
      activeProject_ = state.at("project");
    }
    if (state.contains("projectSettings") && state.at("projectSettings").is_object()) {
      projectSettings_ = defaultProjectSettingsJson();
      projectSettings_.update(state.at("projectSettings"));
    }

    if (state.contains("mediaAssets") && state.at("mediaAssets").is_array()) {
      for (const auto& item : state.at("mediaAssets")) {
        auto media = mediaFromJson(item);
        if (!media.id.empty()) {
          media_.push_back(media);
        }
      }
    }

    if (state.contains("timeline") && state.at("timeline").is_object()) {
      timeline_ = timelineFromJson(state.at("timeline"));
    }
    if (timeline_.tracks.empty()) {
      timeline_.tracks = defaultTracks();
    }

    if (state.contains("aiProposals") && state.at("aiProposals").is_array()) {
      for (const auto& item : state.at("aiProposals")) {
        auto proposal = proposalFromJson(item);
        if (!proposal.id.empty()) {
          proposals_.push_back(proposal);
        }
      }
    }

    recalculateTimelineDuration();
    saveMedia();
    saveTimeline();
    saveProposals();
    saveAppState();
  }

  nlohmann::json importMedia(const nlohmann::json& command, const FfprobeService& ffprobeService) {
    std::vector<std::filesystem::path> copiedFiles;
    try { return mediaTransaction([&] { return importMediaImpl(command, ffprobeService, copiedFiles); }); }
    catch (...) {
      // These are exclusively new files created by this import; never remove a source file.
      for (const auto& file : copiedFiles) { std::error_code ignored; std::filesystem::remove(file, ignored); }
      throw;
    }
  }

  nlohmann::json importMediaImpl(const nlohmann::json& command, const FfprobeService& ffprobeService, std::vector<std::filesystem::path>& copiedFiles) {
    const auto beforeState = projectStateJson();
    if (!command.contains("paths") || !command.at("paths").is_array() || command.at("paths").empty() || command.at("paths").size() > 100) {
      throw std::runtime_error("import_media requires 1 to 100 paths");
    }

    auto imported = nlohmann::json::array();
    std::vector<std::string> sourcePaths;
    for (const auto& item : command.at("paths")) {
      auto path = normalizedMediaPath(item.get<std::string>());
      if (std::any_of(sourcePaths.begin(), sourcePaths.end(), [&](const auto& seen) { return sameMediaPath(seen, path); })) continue;
      sourcePaths.push_back(path);
      if (!isSupportedMediaPath(path)) {
        throw std::runtime_error("unsupported media type: " + path);
      }

      auto metadata = ffprobeService.probe(path).toJson();
      const auto originalName = fileName(path);
      if (command.value("copyToProject", false)) {
        const auto projectPath = activeProject_.value("path", std::string{});
        if (projectPath.empty()) throw std::runtime_error("open a project before copying media into it");
        const auto root = std::filesystem::canonical(std::filesystem::u8path(projectPath));
        const auto directory = root / "media";
        std::filesystem::create_directories(directory);
        if (std::filesystem::canonical(directory).parent_path() != root) throw std::runtime_error("project media folder resolves outside the project");
        const auto copied = directory / std::filesystem::u8path(stableHash(idSeed() + path) + "_" + originalName);
        if (!std::filesystem::copy_file(std::filesystem::u8path(path), copied, std::filesystem::copy_options::none)) throw std::runtime_error("could not copy media into project");
        copiedFiles.push_back(copied);
        path = pathUtf8(copied);
        metadata["path"] = path;
      }
      const auto existing = std::find_if(media_.begin(), media_.end(), [&](const auto& asset) { return sameMediaPath(asset.path, path); });
      const auto id = existing == media_.end() ? mediaIdForPath(path) : existing->id;
      auto media = mediaById(id);
      if (!media) {
        media = IndexedMedia{};
        media->id = id;
      }

      media->path = path;
      if (media->name.empty()) media->name = originalName;
      media->extension = extensionForPath(path);
      media->kind = metadata.value("width", 0) > 0 ? "video" : "audio";
      media->importedAt = nowStamp();
      media->metadata = metadata;
      validateReplacement(*media);
      media->intelligence = intelligenceFor(*media);
      upsertMedia(*media);
      imported.push_back(media->toJson());
    }

    saveMedia();
    auto result = commandResult("import_media", {{"media", imported}, {"mediaIndex", mediaIndexJson()}, {"timeline", timelineJson()}});
    recordCommand(command, beforeState, result);
    return result;
  }

  nlohmann::json relinkMedia(const nlohmann::json& command, const FfprobeService& ffprobeService) {
    return mediaTransaction([&] {
      const auto beforeState = projectStateJson();
      auto media = mediaById(command.at("mediaId").get<std::string>());
      if (!media) throw std::runtime_error("media not found");
      const auto path = normalizedMediaPath(command.at("path").get<std::string>());
      if (!isSupportedMediaPath(path)) throw std::runtime_error("unsupported replacement media type: " + path);
      media->metadata = ffprobeService.probe(path).toJson();
      const auto kind = media->metadata.value("width", 0) > 0 ? "video" : "audio";
      if (media->kind != kind) throw std::runtime_error("replacement must have the same video/audio kind as the original");
      media->path = path;
      media->extension = extensionForPath(path);
      validateReplacement(*media);
      media->intelligence = intelligenceFor(*media);
      upsertMedia(*media);
      saveMedia();
      auto result = commandResult("relink_media", projectStateJson());
      recordCommand(command, beforeState, result);
      return result;
    });
  }

  nlohmann::json removeMedia(const nlohmann::json& command) {
    return mediaTransaction([&] { return removeMediaImpl(command); });
  }

  nlohmann::json removeMediaImpl(const nlohmann::json& command) {
    const auto beforeState = projectStateJson();
    const auto mediaId = command.value("mediaId", std::string{});
    if (mediaId.empty()) {
      throw std::runtime_error("remove_media requires mediaId");
    }

    const auto media = findMedia(mediaId);
    if (!media) {
      throw std::runtime_error("media not found: " + mediaId);
    }

    for (const auto& track : timeline_.tracks) {
      if (track.locked && std::any_of(track.clips.begin(), track.clips.end(), [&](const Clip& clip) { return clip.mediaId == mediaId; })) {
        throw std::runtime_error("media is used on locked track: " + track.id + "; unlock the track before removing it");
      }
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
    auto result = commandResult("remove_media", {{"mediaIndex", mediaIndexJson()}, {"timeline", timelineJson()}});
    recordCommand(command, beforeState, result);
    return result;
  }

  nlohmann::json executeCommand(const nlohmann::json& command) {
    if (command.value("type", std::string{}) == "execute_batch") return executeBatch(command);
    const auto originalTimeline = timeline_;
    const auto originalHistory = history_;
    const auto originalSettings = projectSettings_;
    exec("SAVEPOINT editor_command;");
    try {
      auto result = executeCommandImpl(command);
      exec("RELEASE editor_command;");
      return result;
    } catch (...) {
      timeline_ = originalTimeline;
      history_ = originalHistory;
      projectSettings_ = originalSettings;
      exec("ROLLBACK TO editor_command;");
      exec("RELEASE editor_command;");
      throw;
    }
  }

  nlohmann::json executeBatch(const nlohmann::json& command, const std::string& proposalId = "") {
    if (!command.contains("commands") || !command.at("commands").is_array() || command.at("commands").empty() || command.at("commands").size() > 500) {
      throw std::runtime_error("execute_batch requires between 1 and 500 editing commands");
    }
    const auto beforeState = projectStateJson();
    const auto originalTimeline = timeline_;
    const auto originalProposals = proposals_;
    const auto originalHistory = history_;
    exec("SAVEPOINT editor_batch;");
    try {
      for (auto item : command.at("commands")) {
        const auto type = item.value("type", std::string{});
        if (type == "execute_batch" || type == "import_media" || type == "relink_media" || type == "remove_media" || type == "export_timeline" || type == "update_project_settings") {
          throw std::runtime_error("batch only supports timeline editing commands, not " + type);
        }
        item["history"] = {{"mode", "none"}};
        executeCommand(item);
      }
      if (!proposalId.empty()) {
        auto proposal = proposalById(proposalId);
        if (!proposal || proposal->status != "pending") throw std::runtime_error("proposal is not pending");
        proposal->status = "applied";
        upsertProposal(*proposal);
        saveProposals();
      }
      history_ = originalHistory;
      auto result = commandResult("execute_batch", projectStateJson());
      recordCommand(command, beforeState, result);
      exec("RELEASE editor_batch;");
      return result;
    } catch (...) {
      timeline_ = originalTimeline;
      proposals_ = originalProposals;
      history_ = originalHistory;
      exec("ROLLBACK TO editor_batch;");
      exec("RELEASE editor_batch;");
      throw;
    }
  }

  nlohmann::json executeCommandImpl(const nlohmann::json& command) {
    const auto beforeState = projectStateJson();
    const auto type = command.value("type", std::string{});
    if (type == "update_project_settings") {
      auto settings = projectSettings_;
      settings.update(command.at("settings"));
      const auto width = settings.at("width").get<int>();
      const auto height = settings.at("height").get<int>();
      const auto fps = settings.at("fps").get<int>();
      const auto gain = settings.value("masterGainDb", 0.0);
      if (width < 16 || width > 8192 || height < 16 || height > 8192 || width % 2 != 0 || height % 2 != 0 || (fps != 24 && fps != 25 && fps != 30 && fps != 50 && fps != 60) || !std::isfinite(gain) || gain < -60 || gain > 12) throw std::runtime_error("unsupported project dimensions, frame rate, or audio gain");
      projectSettings_ = settings;
      timeline_.fps = fps;
      saveAppState();
    } else if (type == "import_captions") {
      const auto& cues = command.at("captions");
      const auto mode = command.value("mode", std::string{"append"});
      if (!cues.is_array() || cues.empty() || cues.size() > 5000 || (mode != "append" && mode != "replace")) throw std::runtime_error("import_captions requires 1–5,000 captions and append or replace mode");
      auto titles = timeline_.titles;
      if (mode == "replace") titles.erase(std::remove_if(titles.begin(), titles.end(), [](const auto& title) { return title.kind == "caption"; }), titles.end());
      const auto prefix = "caption_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "_";
      const auto style = command.value("style", nlohmann::json::object());
      if (!style.is_object()) throw std::runtime_error("caption style must be an object");
      for (std::size_t index = 0; index < cues.size(); ++index) {
        const auto& cue = cues.at(index);
        nlohmann::json value = {{"fontSize", 36}, {"positionY", 92}};
        for (const auto& key : {"fontSize", "color", "positionX", "positionY", "background"}) if (style.contains(key)) value[key] = style.at(key);
        value.update({{"id", prefix + std::to_string(index)}, {"kind", "caption"}, {"text", cue.at("text")}, {"startUs", cue.at("startUs")}, {"durationUs", cue.at("durationUs")}});
        titles.push_back(value.get<TitleOverlay>());
      }
      std::stable_sort(titles.begin(), titles.end(), [](const auto& a, const auto& b) { return a.startUs < b.startUs; });
      timeline_.titles = std::move(titles);
    } else if (type == "add_title" || type == "update_title" || type == "delete_title") {
      editTitle(command);
    } else if (type == "add_marker" || type == "update_marker" || type == "delete_marker") {
      editMarker(command);
    } else if (type == "add_track") {
      addTrack(command);
    } else if (type == "update_track") {
      updateTrack(command);
    } else if (type == "add_clip") {
      addClip(command);
    } else if (type == "move_clip") {
      moveClip(command);
    } else if (type == "trim_clip") {
      trimClip(command);
    } else if (type == "set_clip_source_range") {
      auto* clip = findClip(command.at("clipId").get<std::string>());
      if (!clip) throw std::runtime_error("clip not found");
      ensureClipTrackEditable(clip->id, type);
      const auto inUs = command.at("inUs").get<std::int64_t>();
      const auto outUs = command.at("outUs").get<std::int64_t>();
      const auto* media = findMedia(clip->mediaId);
      const auto duration = media && !media->metadata.value("isStillImage", false) ? media->metadata.value("durationUs", 0LL) : 0LL;
      if (inUs < 0 || outUs <= inUs || (duration > 0 && outUs > duration)) throw std::runtime_error("source range is outside media bounds");
      if (clip->inUs != inUs || clip->outUs != outUs) resetFadeRanges(*clip);
      clip->inUs = inUs;
      clip->outUs = outUs;
    } else if (type == "split_clip") {
      splitClip(command);
    } else if (type == "crossfade_clips") {
      auto* first = findClip(command.at("firstClipId").get<std::string>());
      auto* second = findClip(command.at("secondClipId").get<std::string>());
      if (!first || !second || first == second || first->trackId != second->trackId) throw std::runtime_error("crossfade requires two clips on the same video track");
      ensureClipTrackEditable(first->id, type);
      auto* track = findTrack(first->trackId);
      const auto duration = command.at("durationUs").get<std::int64_t>();
      const auto firstEnd = first->startUs + displayedClipDurationUs(*first);
      if (track->kind != TrackKind::Video || std::abs(firstEnd - second->startUs) > 1 || duration <= 0 || duration >= std::min(displayedClipDurationUs(*first), displayedClipDurationUs(*second))) throw std::runtime_error("crossfade needs adjacent video clips and a duration shorter than both clips");
      const auto secondStart = second->startUs;
      resetFadeRanges(*first);
      resetFadeRanges(*second);
      first->transform.fadeOutUs = 0;
      first->audioFadeOutUs = duration;
      second->transform.enabled = true;
      second->transform.fadeInUs = duration;
      second->audioFadeInUs = duration;
      for (auto& clip : track->clips) if (clip.startUs >= secondStart) clip.startUs -= duration;
    } else if (type == "delete_clip") {
      deleteClip(command);
    } else if (type == "ripple_delete_clip") {
      ensureClipTrackEditable(command.value("clipId", std::string{}), "ripple_delete_clip");
      TimelineService::rippleDelete(timeline_, command.value("clipId", std::string{}), command.value("trackMode", std::string{"selected_track"}) == "all_tracks");
    } else if (type == "delete_track") {
      deleteTrack(command);
    } else if (type == "apply_color_adjustment" || type == "apply_lut") {
      applyClipLook(command);
    } else if (type == "apply_audio_adjustment") {
      applyClipAudio(command);
    } else if (type == "apply_clip_speed") {
      applyClipSpeed(command);
    } else if (type == "apply_transform") {
      applyClipTransform(command);
    } else if (type == "apply_effect_stack") {
      applyClipEffects(command);
    } else {
      throw std::runtime_error("unknown command type: " + type);
    }

    recalculateTimelineDuration();
    saveTimeline();
    auto result = commandResult(type, type == "update_project_settings" ? projectStateJson() : nlohmann::json{{"timeline", timelineJson()}});
    recordCommand(command, beforeState, result);
    return result;
  }

  nlohmann::json undoCommand() {
    if (!history_.canUndo()) {
      return commandHistoryResult(false, "Nothing to undo");
    }

    const auto previousHistory = history_;
    const auto entry = history_.undo();
    try { replaceState(entry.beforeState, false); }
    catch (...) { history_ = previousHistory; throw; }
    return commandHistoryResult(true, "", entry.id, entry.type);
  }

  nlohmann::json redoCommand() {
    if (!history_.canRedo()) {
      return commandHistoryResult(false, "Nothing to redo");
    }

    const auto previousHistory = history_;
    const auto entry = history_.redo();
    try { replaceState(entry.afterState, false); }
    catch (...) { history_ = previousHistory; throw; }
    return commandHistoryResult(true, "", entry.id, entry.type);
  }

  [[nodiscard]] nlohmann::json commandHistoryJson() const {
    return history_.statusJson();
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

  nlohmann::json createProposal(const nlohmann::json& params) {
    if (!params.contains("commands") || !params.at("commands").is_array() || params.at("commands").empty() || params.at("commands").size() > 500) {
      throw std::runtime_error("proposal requires between 1 and 500 editing commands");
    }
    // Validate by applying inside an outer savepoint, then restore the original session.
    const auto originalTimeline = timeline_;
    const auto originalHistory = history_;
    exec("SAVEPOINT proposal_validation;");
    try {
      executeBatch({{"type", "execute_batch"}, {"commands", params.at("commands")}});
      exec("ROLLBACK TO proposal_validation;");
      exec("RELEASE proposal_validation;");
      timeline_ = originalTimeline;
      history_ = originalHistory;
    } catch (...) {
      timeline_ = originalTimeline;
      history_ = originalHistory;
      exec("ROLLBACK TO proposal_validation;");
      exec("RELEASE proposal_validation;");
      throw;
    }
    AiEditProposal proposal;
    proposal.id = "proposal_" + stableHash(idSeed());
    proposal.goal = params.value("goal", std::string{"Agent edit proposal"});
    proposal.explanation = params.value("explanation", std::string{});
    proposal.commands = params.at("commands");
    proposal.createdAt = nowStamp();
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

    executeBatch({{"type", "execute_batch"}, {"label", proposal->goal}, {"commands", proposal->commands}}, proposalId);
    return proposalById(proposalId)->toJson();
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
  explicit EditorSession(std::nullptr_t) {}

  void validateReplacement(const IndexedMedia& media) const {
    for (const auto& track : timeline_.tracks) for (const auto& clip : track.clips) {
      if (clip.mediaId != media.id) continue;
      if (track.locked) throw std::runtime_error("media is used on locked track: " + track.name + "; unlock it before replacing the source");
      if (track.kind == TrackKind::Video && media.kind != "video") throw std::runtime_error("replacement has no video required by clip: " + clip.id);
      if (!media.metadata.value("isStillImage", false) && clip.outUs > media.metadata.value("durationUs", 0LL)) throw std::runtime_error("replacement is shorter than the source range used by clip: " + clip.id);
      const auto* previous = findMedia(media.id);
      const auto needsAudio = track.kind == TrackKind::Audio || (previous && previous->metadata.value("hasAudio", false) && !clip.audioMuted);
      if (needsAudio && (!media.metadata.value("hasAudio", false) || clip.audioStreamIndex >= media.metadata.value("audioStreamCount", 0))) throw std::runtime_error("replacement lacks the audio stream used by clip: " + clip.id);
    }
  }

  static std::string pathUtf8(const std::filesystem::path& path) {
    const auto value = path.u8string();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
  }
  static std::string normalizedMediaPath(const std::string& path) {
    if (path.empty() || path.find('\0') != std::string::npos) throw std::runtime_error("media path is empty or invalid");
    return pathUtf8(std::filesystem::weakly_canonical(std::filesystem::absolute(std::filesystem::u8path(path))));
  }
  static bool sameMediaPath(const std::string& left, const std::string& right) {
    std::error_code error;
    return left == right || std::filesystem::equivalent(std::filesystem::u8path(left), std::filesystem::u8path(right), error);
  }

  template <typename Action>
  nlohmann::json mediaTransaction(Action action) {
    const auto originalMedia = media_;
    const auto originalTimeline = timeline_;
    const auto originalHistory = history_;
    exec("SAVEPOINT media_command;");
    try {
      auto result = action();
      exec("RELEASE media_command;");
      return result;
    } catch (...) {
      media_ = originalMedia;
      timeline_ = originalTimeline;
      history_ = originalHistory;
      exec("ROLLBACK TO media_command;");
      exec("RELEASE media_command;");
      throw;
    }
  }
  static IndexedMedia mediaFromJson(const nlohmann::json& value) {
    IndexedMedia media;
    media.id = value.value("id", std::string{});
    media.path = value.value("path", std::string{});
    media.name = value.value("name", fileName(media.path));
    media.kind = value.value("kind", std::string{"video"});
    media.extension = value.value("extension", extensionForPath(media.path));
    media.importedAt = value.value("importedAt", nowStamp());
    media.metadata = value.value("metadata", nlohmann::json::object());
    media.intelligence = value.value("intelligence", intelligenceFor(media));
    return media;
  }

  static Timeline timelineFromJson(const nlohmann::json& value) {
    Timeline timeline;
    timeline.id = value.value("id", timeline.id);
    timeline.name = value.value("name", timeline.name);
    timeline.fps = value.value("fps", timeline.fps);
    timeline.durationUs = value.value("durationUs", timeline.durationUs);
    timeline.markers = markersFromJson(value.value("markers", nlohmann::json::array()));
    timeline.titles = value.value("titles", std::vector<TitleOverlay>{});

    if (value.contains("tracks") && value.at("tracks").is_array()) {
      for (const auto& item : value.at("tracks")) {
        Track track;
        track.id = item.value("id", std::string{});
        track.name = item.value("name", track.id);
        track.kind = item.value("kind", std::string{"video"}) == "audio" ? TrackKind::Audio : TrackKind::Video;
        track.index = item.value("index", static_cast<int>(timeline.tracks.size()));
        track.locked = item.value("locked", false);
        track.muted = item.value("muted", false);
        track.visible = item.value("visible", true);

        if (item.contains("clips") && item.at("clips").is_array()) {
          for (const auto& clipItem : item.at("clips")) {
            auto clip = clipFromJson(clipItem, track.id);
            if (!clip.id.empty() && !clip.mediaId.empty()) {
              track.clips.push_back(clip);
            }
          }
          sortTrack(track);
        }

        if (!track.id.empty()) {
          timeline.tracks.push_back(track);
        }
      }
    }

    return timeline;
  }

  static Clip clipFromJson(const nlohmann::json& value, const std::string& fallbackTrackId) {
    Clip clip;
    clip.id = value.value("id", std::string{});
    clip.mediaId = value.value("mediaId", std::string{});
    clip.trackId = value.value("trackId", fallbackTrackId);
    clip.startUs = value.value("startUs", 0LL);
    clip.inUs = value.value("inUs", 0LL);
    clip.outUs = value.value("outUs", clip.inUs + 1'000'000LL);
    clip.speedPercent = normalizeSpeedPercent(value.value("speedPercent", 100.0));

    const auto color = value.contains("color") ? value.at("color") : defaultColorJson();
    clip.color.brightness = color.value("brightness", 0.0);
    clip.color.contrast = color.value("contrast", 0.0);
    clip.color.saturation = color.value("saturation", 1.0);
    clip.color.temperature = color.value("temperature", 0.0);
    clip.color.tint = color.value("tint", 0.0);
    clip.color.lutId = color.value("lutId", std::string{});
    clip.color.lutStrength = color.value("lutStrength", 1.0);

    if (value.contains("lut") && value.at("lut").is_object()) {
      clip.color.lutId = value.at("lut").value("lutId", clip.color.lutId);
      clip.color.lutStrength = value.at("lut").value("strength", clip.color.lutStrength);
    }

    const auto audio = value.contains("audio") ? value.at("audio") : defaultAudioJson();
    clip.audioGainDb = audio.value("gainDb", 0.0);
    clip.audioMuted = audio.value("muted", false);
    clip.audioFadeInUs = audio.value("fadeInUs", 0LL);
    clip.audioFadeOutUs = audio.value("fadeOutUs", 0LL);
    clip.audioFadeOffsetUs = audio.value("fadeOffsetUs", 0LL);
    clip.audioFadeDurationUs = audio.value("fadeDurationUs", 0LL);
    validateFadeRange(clip.audioFadeInUs, clip.audioFadeOutUs, clip.audioFadeOffsetUs, clip.audioFadeDurationUs);
    clip.audioNormalize = audio.value("normalize", false);
    clip.audioCleanup = audio.value("cleanup", false);
    clip.audioStreamIndex = audio.value("streamIndex", 0);

    if (value.contains("transform")) {
      clip.transform = transformFromJson(value.at("transform"));
    }
    if (value.contains("effects")) {
      clip.effects = effectsFromJson(value.at("effects"));
    }

    return clip;
  }

  static AiEditProposal proposalFromJson(const nlohmann::json& value) {
    AiEditProposal proposal;
    proposal.id = value.value("id", std::string{});
    proposal.goal = value.value("goal", std::string{});
    proposal.status = value.value("status", std::string{"pending"});
    proposal.explanation = value.value("explanation", std::string{});
    proposal.commands = value.value("commands", nlohmann::json::array());
    proposal.createdAt = value.value("createdAt", nowStamp());
    return proposal;
  }

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
        effects_json TEXT NOT NULL DEFAULT '[]',
        speed_percent REAL NOT NULL DEFAULT 100
      );
    )sql");
    ensureColumn("timeline_clips", "audio_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("timeline_clips", "transform_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("timeline_clips", "effects_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("timeline_clips", "speed_percent", "REAL NOT NULL DEFAULT 100");
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
    exec(R"sql(
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    )sql");
  }

  void load() {
    loadMedia();
    loadTracks();
    loadClips();
    loadProposals();
    loadAppState();
    timeline_.fps = projectSettings_.value("fps", 30);
    if (timeline_.tracks.empty()) {
      timeline_.tracks = defaultTracks();
      saveTimeline();
    }
    recalculateTimelineDuration();
  }

  void closeDatabase() {
    if (db_) {
      // A malformed row can throw while a SELECT is live. Finalize it before closing.
      while (auto* statement = sqlite3_next_stmt(db_, nullptr)) sqlite3_finalize(statement);
      sqlite3_close(db_);
      db_ = nullptr;
    }
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
    prepare("SELECT id,media_id,track_id,start_us,in_us,out_us,color_json,audio_json,transform_json,effects_json,speed_percent FROM timeline_clips ORDER BY start_us ASC;", &statement);
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
      clip.audioFadeOffsetUs = audio.value("fadeOffsetUs", 0LL);
      clip.audioFadeDurationUs = audio.value("fadeDurationUs", 0LL);
      validateFadeRange(clip.audioFadeInUs, clip.audioFadeOutUs, clip.audioFadeOffsetUs, clip.audioFadeDurationUs);
      clip.audioNormalize = audio.value("normalize", false);
      clip.audioCleanup = audio.value("cleanup", false);
      clip.audioStreamIndex = audio.value("streamIndex", 0);
      clip.transform = transformFromJson(parseJson(columnText(statement, 8), defaultTransformJson()));
      clip.effects = effectsFromJson(parseJson(columnText(statement, 9), defaultEffectsJson()));
      clip.speedPercent = normalizeSpeedPercent(sqlite3_column_double(statement, 10));
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

  void loadAppState() {
    sqlite3_stmt* statement = nullptr;
    prepare("SELECT key,value_json FROM app_state;", &statement);
    while (sqlite3_step(statement) == SQLITE_ROW) {
      const auto key = columnText(statement, 0);
      const auto value = parseJson(columnText(statement, 1), nlohmann::json::object());
      if (key == "project_settings" && value.is_object()) {
        projectSettings_ = defaultProjectSettingsJson();
        projectSettings_.update(value);
      } else if (key == "project" && value.is_object()) {
        activeProject_ = value;
      } else if (key == "timeline_markers" && value.is_array()) {
        timeline_.markers = markersFromJson(value);
      } else if (key == "timeline_titles" && value.is_array()) {
        timeline_.titles = value.get<std::vector<TitleOverlay>>();
      } else if (key == "saved_at" && value.is_string()) {
        savedAt_ = value.get<std::string>();
      }
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
    upsertAppState("timeline_markers", markersJson());
    upsertAppState("timeline_titles", timeline_.titles);
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
        prepare("INSERT INTO timeline_clips(id,media_id,track_id,start_us,in_us,out_us,color_json,audio_json,transform_json,effects_json,speed_percent) VALUES(?,?,?,?,?,?,?,?,?,?,?);", &clipStatement);
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
        sqlite3_bind_double(clipStatement, 11, normalizeSpeedPercent(clip.speedPercent));
        stepDone(clipStatement);
      }
    }
  }

  static std::vector<TimelineMarker> markersFromJson(const nlohmann::json& rows) {
    std::vector<TimelineMarker> markers;
    for (const auto& row : rows) {
      TimelineMarker marker{row.at("id").get<std::string>(), row.at("timeUs").get<std::int64_t>(), row.value("name", std::string{"Marker"}), row.value("color", std::string{"#f5c76b"})};
      validateMarker(marker);
      if (std::any_of(markers.begin(), markers.end(), [&](const auto& other) { return other.id == marker.id; })) throw std::runtime_error("duplicate marker ID");
      markers.push_back(marker);
    }
    return markers;
  }

  static void validateMarker(const TimelineMarker& marker) {
    if (marker.id.empty() || marker.timeUs < 0 || marker.name.empty() || marker.name.size() > 200) throw std::runtime_error("marker requires an ID, nonnegative time, and a name up to 200 characters");
    if (marker.color.size() != 7 || marker.color[0] != '#' || !std::all_of(marker.color.begin() + 1, marker.color.end(), [](unsigned char ch) { return std::isxdigit(ch); })) throw std::runtime_error("marker color must be #RRGGBB");
  }

  nlohmann::json markersJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& marker : timeline_.markers) rows.push_back({{"id", marker.id}, {"timeUs", marker.timeUs}, {"name", marker.name}, {"color", marker.color}});
    return rows;
  }

  void editMarker(const nlohmann::json& command) {
    const auto type = command.at("type").get<std::string>();
    const auto id = command.value("markerId", "marker_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    auto it = std::find_if(timeline_.markers.begin(), timeline_.markers.end(), [&](const auto& marker) { return marker.id == id; });
    if (type == "add_marker") {
      if (it != timeline_.markers.end()) throw std::runtime_error("marker ID already exists");
      TimelineMarker marker{id, command.at("timeUs").get<std::int64_t>(), command.value("name", std::string{"Marker"}), command.value("color", std::string{"#f5c76b"})};
      validateMarker(marker);
      timeline_.markers.push_back(marker);
    } else {
      if (it == timeline_.markers.end()) throw std::runtime_error("marker not found");
      if (type == "delete_marker") timeline_.markers.erase(it);
      else {
        it->timeUs = command.value("timeUs", it->timeUs);
        it->name = command.value("name", it->name);
        it->color = command.value("color", it->color);
        validateMarker(*it);
      }
    }
    std::stable_sort(timeline_.markers.begin(), timeline_.markers.end(), [](const auto& a, const auto& b) { return a.timeUs < b.timeUs; });
  }

  void editTitle(const nlohmann::json& command) {
    const auto type = command.at("type").get<std::string>();
    const auto id = command.value("titleId", "title_" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    auto it = std::find_if(timeline_.titles.begin(), timeline_.titles.end(), [&](const auto& title) { return title.id == id; });
    if (type == "add_title") {
      if (it != timeline_.titles.end()) throw std::runtime_error("title ID already exists");
      auto value = command;
      value["id"] = id;
      timeline_.titles.push_back(value.get<TitleOverlay>());
    } else {
      if (it == timeline_.titles.end()) throw std::runtime_error("title not found");
      if (type == "delete_title") timeline_.titles.erase(it);
      else {
        nlohmann::json value = *it;
        value.update(command);
        *it = value.get<TitleOverlay>();
      }
    }
    std::stable_sort(timeline_.titles.begin(), timeline_.titles.end(), [](const auto& a, const auto& b) { return a.startUs < b.startUs; });
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

  void saveAppState() {
    upsertAppState("project_settings", projectSettings_);
    upsertAppState("project", activeProject_);
    upsertAppState("saved_at", savedAt_);
  }

  void upsertAppState(const std::string& key, const nlohmann::json& value) {
    sqlite3_stmt* statement = nullptr;
    prepare("INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;", &statement);
    bindText(statement, 1, key);
    bindText(statement, 2, value.dump());
    bindText(statement, 3, nowStamp());
    stepDone(statement);
  }

  void addTrack(const nlohmann::json& command) {
    const auto kind = command.value("kind", std::string{"video"});
    if (kind != "video" && kind != "audio") throw std::runtime_error("track kind must be video or audio");
    Track track;
    track.kind = kind == "audio" ? TrackKind::Audio : TrackKind::Video;
    const auto requestedIndex = command.value("index", static_cast<int>(timeline_.tracks.size()));
    track.index = std::clamp(requestedIndex, 0, static_cast<int>(timeline_.tracks.size()));
    track.id = command.value("trackId", "track_" + stableHash(idSeed() + kind));
    if (track.id.empty() || findTrack(track.id)) throw std::runtime_error("track ID must be unique and nonempty");
    track.name = command.value("name", std::string{kind == "audio" ? "Audio " : "Video "} + std::to_string(track.index + 1));
    timeline_.tracks.insert(timeline_.tracks.begin() + track.index, track);
    reindexTracks();
  }

  void updateTrack(const nlohmann::json& command) {
    auto* track = findTrack(command.value("trackId", std::string{}));
    if (!track) {
      throw std::runtime_error("track not found");
    }
    if (command.contains("name")) {
      const auto name = command.at("name").get<std::string>();
      if (!name.empty()) {
        track->name = name;
      }
    }
    track->locked = command.value("locked", track->locked);
    track->muted = command.value("muted", track->muted);
    track->visible = command.value("visible", track->visible);
  }

  void deleteTrack(const nlohmann::json& command) {
    const auto trackId = command.value("trackId", std::string{});
    const auto* target = findTrack(trackId);
    if (!target) throw std::runtime_error("track not found");
    if (target->locked) throw std::runtime_error("cannot delete a locked track");
    timeline_.tracks.erase(std::remove_if(timeline_.tracks.begin(), timeline_.tracks.end(), [&](const Track& track) {
                             return track.id == trackId;
                           }),
                           timeline_.tracks.end());
    reindexTracks();
  }

  void addClip(const nlohmann::json& command) {
    auto* track = findTrack(command.value("trackId", std::string{}));
    if (!track) {
      throw std::runtime_error("add_clip target track not found");
    }
    if (track->locked) {
      throw std::runtime_error("add_clip target track is locked");
    }

    const auto mediaId = command.value("mediaId", std::string{});
    const auto* media = findMedia(mediaId);
    if (!media) {
      throw std::runtime_error("add_clip media not found: " + mediaId);
    }
    if (!canPlaceMediaOnTrack(*media, *track)) {
      throw std::runtime_error("add_clip media is not compatible with target track");
    }

    Clip clip;
    clip.id = command.value("clipId", std::string{"clip_" + stableHash(idSeed() + mediaId + std::to_string(track->clips.size()))});
    clip.mediaId = mediaId;
    clip.trackId = track->id;
    clip.startUs = command.value("startUs", 0LL);
    clip.inUs = command.value("inUs", 0LL);
    const auto sourceDurationUs = media->metadata.value("durationUs", 0LL);
    clip.outUs = command.value("outUs", sourceDurationUs > 0 ? sourceDurationUs : clip.inUs + 8'000'000LL);
    clip.speedPercent = normalizeSpeedPercent(command.value("speedPercent", 100.0));
    const auto durationUs = media->metadata.value("isStillImage", false) ? 0LL : media->metadata.value("durationUs", 0LL);
    if (clip.startUs < 0 || clip.inUs < 0 || clip.outUs <= clip.inUs || (durationUs > 0 && clip.outUs > durationUs)) {
      throw std::runtime_error("clip timing must be nonnegative and within the source duration");
    }
    if (auto* existing = findClip(clip.id); existing && existing->trackId != track->id) {
      throw std::runtime_error("clip ID already exists on another track");
    }
    auto properties = clipFromJson(command, track->id);
    clip.color = properties.color;
    clip.transform = properties.transform;
    clip.effects = properties.effects;
    clip.audioGainDb = properties.audioGainDb;
    clip.audioMuted = properties.audioMuted;
    clip.audioFadeInUs = properties.audioFadeInUs;
    clip.audioFadeOutUs = properties.audioFadeOutUs;
    clip.audioFadeOffsetUs = properties.audioFadeOffsetUs;
    clip.audioFadeDurationUs = properties.audioFadeDurationUs;
    clip.audioNormalize = properties.audioNormalize;
    clip.audioCleanup = properties.audioCleanup;
    clip.audioStreamIndex = properties.audioStreamIndex;
    track->clips.erase(std::remove_if(track->clips.begin(), track->clips.end(), [&](const Clip& existing) {
                         return existing.id == clip.id;
                       }),
                       track->clips.end());
    track->clips.push_back(clip);
    sortTrack(*track);
  }

  void moveClip(const nlohmann::json& command) {
    const auto clipId = command.value("clipId", std::string{});
    auto* existingClip = findClip(clipId);
    if (!existingClip) {
      throw std::runtime_error("clip not found: " + clipId);
    }
    auto* sourceTrack = findTrack(existingClip->trackId);
    const auto targetTrackId = command.value("trackId", existingClip->trackId);
    auto* track = findTrack(targetTrackId);
    if (!track) {
      throw std::runtime_error("move_clip target track not found");
    }
    if (sourceTrack && sourceTrack->locked) {
      throw std::runtime_error("move_clip source track is locked");
    }
    if (track->locked) {
      throw std::runtime_error("move_clip target track is locked");
    }
    if (sourceTrack && sourceTrack->kind != track->kind) {
      throw std::runtime_error("move_clip cannot move clips between video and audio tracks");
    }

    const auto nextStartUs = command.value("startUs", existingClip->startUs);
    if (nextStartUs < 0) throw std::runtime_error("clip start cannot be negative");
    if (targetTrackId == existingClip->trackId && nextStartUs == existingClip->startUs) {
      return;
    }

    auto clip = removeClip(clipId);
    clip.trackId = targetTrackId;
    clip.startUs = nextStartUs;
    track->clips.push_back(clip);
    sortTrack(*track);
  }

  static void validateFadeRange(std::int64_t fadeIn, std::int64_t fadeOut, std::int64_t offset, std::int64_t duration) {
    constexpr auto maxTime = 9'007'199'254'740'991LL;
    if (fadeIn < 0 || fadeOut < 0 || fadeIn > maxTime || fadeOut > maxTime || offset < 0 || duration < 0 || offset > duration || duration > maxTime) throw std::runtime_error("invalid fade duration or range");
  }

  static void resetFadeRanges(Clip& clip) {
    clip.transform.fadeOffsetUs = clip.transform.fadeDurationUs = 0;
    clip.audioFadeOffsetUs = clip.audioFadeDurationUs = 0;
  }

  void trimClip(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("trim_clip clip not found");
    }
    ensureClipTrackEditable(clip->id, "trim_clip");
    const auto edge = command.value("edge", std::string{"end"});
    const auto timeUs = command.value("timeUs", edge == "start" ? clip->startUs : clip->outUs);
    if (edge != "start" && edge != "end") throw std::runtime_error("trim edge must be start or end");
    if (timeUs < 0) throw std::runtime_error("trim time cannot be negative");
    if (edge == "start") {
      const auto timelineDeltaUs = std::max<std::int64_t>(0, timeUs) - clip->startUs;
      const auto sourceDeltaUs = static_cast<std::int64_t>(std::llround(
          static_cast<double>(timelineDeltaUs) * normalizeSpeedPercent(clip->speedPercent) / 100.0));
      const auto nextInUs = clip->inUs + sourceDeltaUs;
      if (nextInUs < 0 || nextInUs >= clip->outUs) throw std::runtime_error("trim start is outside the source range");
      if (clip->inUs != nextInUs) resetFadeRanges(*clip);
      clip->startUs = timeUs;
      clip->inUs = nextInUs;
    } else {
      const auto* media = findMedia(clip->mediaId);
      const auto durationUs = media && !media->metadata.value("isStillImage", false) ? media->metadata.value("durationUs", 0LL) : 0LL;
      if (timeUs <= clip->inUs || (durationUs > 0 && timeUs > durationUs)) throw std::runtime_error("trim end is outside the source range");
      if (clip->outUs != timeUs) resetFadeRanges(*clip);
      clip->outUs = timeUs;
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
    if (playheadUs <= clip->startUs || playheadUs >= clip->startUs + displayedClipDurationUs(*clip)) {
      return;
    }

    const auto firstOutUs = clip->inUs + static_cast<std::int64_t>(std::llround(
                                                 static_cast<double>(playheadUs - clip->startUs) *
                                                 normalizeSpeedPercent(clip->speedPercent) / 100.0));
    ensureClipTrackEditable(clip->id, "split_clip");
    if (firstOutUs <= clip->inUs || firstOutUs >= clip->outUs) return;
    const auto originalDuration = displayedClipDurationUs(*clip);
    if (clip->transform.fadeInUs > 0 || clip->transform.fadeOutUs > 0) {
      if (clip->transform.fadeDurationUs <= 0) clip->transform.fadeDurationUs = originalDuration;
    }
    if (clip->audioFadeInUs > 0 || clip->audioFadeOutUs > 0) {
      if (clip->audioFadeDurationUs <= 0) clip->audioFadeDurationUs = originalDuration;
    }
    Clip second = *clip;
    if (second.transform.fadeDurationUs > 0) second.transform.fadeOffsetUs += playheadUs - clip->startUs;
    if (second.audioFadeDurationUs > 0) second.audioFadeOffsetUs += playheadUs - clip->startUs;
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
    ensureClipTrackEditable(command.value("clipId", std::string{}), "delete_clip");
    (void)removeClip(command.value("clipId", std::string{}));
  }

  void applyClipLook(const nlohmann::json& command) {
    ensureClipTrackEditable(command.value("clipId", std::string{}), "apply_clip_look");
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
    ensureClipTrackEditable(command.value("clipId", std::string{}), "apply_audio_adjustment");
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    if (command.contains("adjustment")) {
      const auto adjustment = command.at("adjustment");
      clip->audioGainDb = adjustment.value("gainDb", clip->audioGainDb);
      clip->audioMuted = adjustment.value("muted", clip->audioMuted);
      const bool fadesChanged = adjustment.value("fadeInUs", clip->audioFadeInUs) != clip->audioFadeInUs || adjustment.value("fadeOutUs", clip->audioFadeOutUs) != clip->audioFadeOutUs;
      clip->audioFadeOffsetUs = fadesChanged ? 0LL : adjustment.value("fadeOffsetUs", clip->audioFadeOffsetUs);
      clip->audioFadeDurationUs = fadesChanged ? 0LL : adjustment.value("fadeDurationUs", clip->audioFadeDurationUs);
      clip->audioFadeInUs = adjustment.value("fadeInUs", clip->audioFadeInUs);
      clip->audioFadeOutUs = adjustment.value("fadeOutUs", clip->audioFadeOutUs);
      validateFadeRange(clip->audioFadeInUs, clip->audioFadeOutUs, clip->audioFadeOffsetUs, clip->audioFadeDurationUs);
      clip->audioNormalize = adjustment.value("normalize", clip->audioNormalize);
      clip->audioCleanup = adjustment.value("cleanup", clip->audioCleanup);
      clip->audioStreamIndex = adjustment.value("streamIndex", clip->audioStreamIndex);
    }
  }

  void applyClipSpeed(const nlohmann::json& command) {
    auto* clip = findClip(command.value("clipId", std::string{}));
    if (!clip) {
      throw std::runtime_error("clip not found");
    }
    ensureClipTrackEditable(clip->id, "apply_clip_speed");
    const auto speed = normalizeSpeedPercent(command.value("speedPercent", clip->speedPercent));
    if (speed != clip->speedPercent) resetFadeRanges(*clip);
    clip->speedPercent = speed;
  }

  void applyClipTransform(const nlohmann::json& command) {
    ensureClipTrackEditable(command.value("clipId", std::string{}), "apply_transform");
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
      const bool fadesChanged = transform.value("fadeInUs", clip->transform.fadeInUs) != clip->transform.fadeInUs || transform.value("fadeOutUs", clip->transform.fadeOutUs) != clip->transform.fadeOutUs;
      clip->transform.fadeOffsetUs = fadesChanged ? 0LL : transform.value("fadeOffsetUs", clip->transform.fadeOffsetUs);
      clip->transform.fadeDurationUs = fadesChanged ? 0LL : transform.value("fadeDurationUs", clip->transform.fadeDurationUs);
      clip->transform.fadeInUs = transform.value("fadeInUs", clip->transform.fadeInUs);
      clip->transform.fadeOutUs = transform.value("fadeOutUs", clip->transform.fadeOutUs);
      validateFadeRange(clip->transform.fadeInUs, clip->transform.fadeOutUs, clip->transform.fadeOffsetUs, clip->transform.fadeDurationUs);
    }
  }

  void applyClipEffects(const nlohmann::json& command) {
    ensureClipTrackEditable(command.value("clipId", std::string{}), "apply_effect_stack");
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
            {"speedPercent", normalizeSpeedPercent(clip.speedPercent)},
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

  [[nodiscard]] nlohmann::json mediaRowsJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& media : media_) {
      rows.push_back(media.toJson());
    }
    return rows;
  }

  [[nodiscard]] nlohmann::json proposalRowsJson() const {
    auto rows = nlohmann::json::array();
    for (const auto& proposal : proposals_) {
      rows.push_back(proposal.toJson());
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
        {"undoCount", history_.undoCount()},
        {"redoCount", history_.redoCount()},
    };
  }

  void recordCommand(const nlohmann::json& command, const nlohmann::json& beforeState, nlohmann::json& result) {
    const auto afterState = projectStateJson();
    if (beforeState.dump() == afterState.dump()) {
      result["undoCount"] = history_.undoCount();
      result["redoCount"] = history_.redoCount();
      return;
    }

    const auto type = command.value("type", std::string{"command"});
    const auto commandId = type + "_" + stableHash(idSeed() + beforeState.dump() + afterState.dump());
    const auto historyPolicy = command.value("history", nlohmann::json::object());
    const auto historyMode = historyPolicy.value("mode", std::string{"push"});
    const auto historyGroup = historyPolicy.value("group", std::string{});
    if (historyMode == "none") {
      history_.clearRedo();
      result["commandId"] = commandId;
      result["undoCount"] = history_.undoCount();
      result["redoCount"] = history_.redoCount();
      return;
    }

    history_.push({commandId, type, historyGroup, command, beforeState, afterState}, historyMode == "replace");
    result["commandId"] = commandId;
    result["undoCount"] = history_.undoCount();
    result["redoCount"] = history_.redoCount();
  }

  [[nodiscard]] nlohmann::json commandHistoryResult(bool ok, const std::string& error = "", const std::string& commandId = "", const std::string& commandType = "") const {
    auto result = nlohmann::json{
        {"ok", ok},
        {"data", projectStateJson()},
        {"undoCount", history_.undoCount()},
        {"redoCount", history_.redoCount()},
    };
    if (!commandId.empty()) {
      result["commandId"] = commandId;
    }
    if (!commandType.empty()) {
      result["commandType"] = commandType;
    }
    if (!error.empty()) {
      result["error"] = error;
    }
    return result;
  }

  void recalculateTimelineDuration() {
    constexpr std::int64_t minTimelineDurationUs = 10'000'000;
    constexpr std::int64_t timelineTailRoomUs = 10'000'000;
    std::int64_t duration = 0;
    for (const auto& marker : timeline_.markers) duration = std::max(duration, marker.timeUs);
    for (const auto& title : timeline_.titles) duration = std::max(duration, title.startUs + title.durationUs);
    for (const auto& track : timeline_.tracks) {
      for (const auto& clip : track.clips) {
        duration = std::max(duration, clip.startUs + displayedClipDurationUs(clip));
      }
    }
    timeline_.durationUs = std::max<std::int64_t>(minTimelineDurationUs, duration + timelineTailRoomUs);
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
        if (playheadUs > clip.startUs && playheadUs < clip.startUs + displayedClipDurationUs(clip)) {
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

  void ensureClipTrackEditable(const std::string& clipId, const std::string& commandType) {
    auto* clip = findClip(clipId);
    if (!clip) {
      throw std::runtime_error(commandType + " clip not found");
    }
    auto* track = findTrack(clip->trackId);
    if (track && track->locked) {
      throw std::runtime_error(commandType + " track is locked");
    }
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

  static bool canPlaceMediaOnTrack(const IndexedMedia& media, const Track& track) {
    if (track.kind == TrackKind::Video) {
      return media.kind == "video";
    }
    return media.kind == "audio" || media.metadata.value("hasAudio", false);
  }

  void reindexTracks() {
    for (std::size_t index = 0; index < timeline_.tracks.size(); ++index) {
      timeline_.tracks.at(index).index = static_cast<int>(index);
    }
  }

  static double normalizeSpeedPercent(double value) {
    if (!std::isfinite(value)) {
      return 100.0;
    }
    return std::clamp(value, 25.0, 400.0);
  }

  static std::int64_t displayedClipDurationUs(const Clip& clip) {
    const auto sourceDuration = std::max<std::int64_t>(0, clip.outUs - clip.inUs);
    const auto speed = normalizeSpeedPercent(clip.speedPercent) / 100.0;
    return static_cast<std::int64_t>(std::llround(static_cast<double>(sourceDuration) / speed));
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
        {"fadeOffsetUs", clip.audioFadeOffsetUs},
        {"fadeDurationUs", clip.audioFadeDurationUs},
        {"normalize", clip.audioNormalize},
        {"cleanup", clip.audioCleanup},
        {"streamIndex", clip.audioStreamIndex},
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
        {"fadeInUs", transform.fadeInUs},
        {"fadeOutUs", transform.fadeOutUs},
        {"fadeOffsetUs", transform.fadeOffsetUs},
        {"fadeDurationUs", transform.fadeDurationUs},
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
    transform.fadeInUs = value.value("fadeInUs", 0LL);
    transform.fadeOutUs = value.value("fadeOutUs", 0LL);
    transform.fadeOffsetUs = value.value("fadeOffsetUs", 0LL);
    transform.fadeDurationUs = value.value("fadeDurationUs", 0LL);
    validateFadeRange(transform.fadeInUs, transform.fadeOutUs, transform.fadeOffsetUs, transform.fadeDurationUs);
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
    return {{"gainDb", 0}, {"muted", false}, {"fadeInUs", 0}, {"fadeOutUs", 0}, {"normalize", false}, {"cleanup", false}, {"streamIndex", 0}};
  }

  static nlohmann::json defaultTransformJson() {
    return {{"enabled", true}, {"scale", 1}, {"positionX", 0}, {"positionY", 0}, {"rotation", 0}, {"opacity", 1}};
  }

  static nlohmann::json defaultEffectsJson() {
    return nlohmann::json::array();
  }

  static nlohmann::json defaultProjectSettingsJson() {
    return {
        {"resolution", "1080p"},
        {"width", 1920},
        {"height", 1080},
        {"fps", 30},
        {"colorMode", "SDR"},
        {"bitrateMbps", 9},
        {"defaultCodec", "h264_nvenc"},
        {"defaultContainer", "mp4"},
        {"audioEnabled", true},
        {"masterGainDb", 0},
        {"normalizeAudio", false},
        {"cleanupAudio", false},
    };
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
    return extension == "mp4" || extension == "mov" || extension == "mkv" || extension == "webm" || extension == "avi" || extension == "m4v" || extension == "mts" || extension == "m2ts" || extension == "png" || extension == "jpg" || extension == "jpeg" || extension == "bmp" || extension == "webp" || isAudioExtension(extension);
  }

  static bool isAudioExtension(const std::string& extension) {
    return extension == "mp3" || extension == "wav" || extension == "flac" || extension == "m4a" || extension == "aac" || extension == "ogg" || extension == "opus" || extension == "aiff" || extension == "aif";
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
    const auto name = pathUtf8(std::filesystem::u8path(path).filename());
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
    const auto now = std::chrono::system_clock::now();
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch());
    const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(milliseconds);
    const auto fractionalMilliseconds = milliseconds - seconds;
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
#ifdef _WIN32
    gmtime_s(&utc, &time);
#else
    gmtime_r(&time, &utc);
#endif

    std::ostringstream stream;
    stream << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3) << std::setfill('0')
           << fractionalMilliseconds.count() << 'Z';
    return stream.str();
  }

  static nlohmann::json parseJson(const std::string& value, const nlohmann::json& fallback) {
    if (value.empty()) return fallback;
    try {
      return nlohmann::json::parse(value);
    } catch (...) {
      throw std::runtime_error("project database contains invalid JSON; restore a backup before opening it");
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
  CommandHistory history_;
  nlohmann::json projectSettings_ = nlohmann::json::object();
  nlohmann::json activeProject_ = nlohmann::json::object();
  std::string savedAt_;
};

}  // namespace ai_editor
