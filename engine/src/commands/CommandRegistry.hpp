#pragma once

#include "commands/CommandHistory.hpp"
#include "media/MediaImporter.hpp"

#include <nlohmann/json.hpp>

#include <chrono>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace ai_editor {

class CommandRegistry {
 public:
  explicit CommandRegistry(MediaImporter& mediaImporter) : mediaImporter_(mediaImporter) {}

  nlohmann::json execute(const nlohmann::json& command) {
    const auto type = command.value("type", std::string{});
    if (!isKnown(type)) {
      throw std::runtime_error("unknown command type: " + type);
    }

    nlohmann::json data = nlohmann::json::object();
    if (type == "import_media") {
      data = mediaImporter_.import(command).toJson();
    }

    const auto id = nextCommandId(type);
    history_.push(id, type);

    return {
        {"ok", true},
        {"commandId", id},
        {"data", data},
        {"undoCount", history_.undoCount()},
        {"redoCount", history_.redoCount()},
    };
  }

 private:
  bool isKnown(const std::string& type) const {
    static const std::unordered_set<std::string> known = {
        "import_media",
        "add_track",
        "delete_track",
        "add_clip",
        "move_clip",
        "trim_clip",
        "split_clip",
        "delete_clip",
        "ripple_delete_clip",
        "apply_color_adjustment",
        "apply_audio_adjustment",
        "apply_transform",
        "apply_effect_stack",
        "apply_lut",
        "export_timeline",
    };

    return known.contains(type);
  }

  static std::string nextCommandId(const std::string& type) {
    const auto now = std::chrono::steady_clock::now().time_since_epoch().count();
    return type + "_" + std::to_string(now);
  }

  MediaImporter& mediaImporter_;
  CommandHistory history_;
};

}  // namespace ai_editor
