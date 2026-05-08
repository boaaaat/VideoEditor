#pragma once

#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace ai_editor {

struct CommandHistoryEntry {
  std::string id;
  std::string type;
  std::string group;
  nlohmann::json command;
  nlohmann::json beforeState;
  nlohmann::json afterState;
};

class CommandHistory {
 public:
  static constexpr std::size_t maxEntries = 200;

  void push(CommandHistoryEntry entry, bool replaceLatest = false) {
    if (replaceLatest && !entry.group.empty() && !undoStack_.empty()) {
      auto& latest = undoStack_.back();
      if (latest.group == entry.group) {
        entry.beforeState = latest.beforeState;
        latest = std::move(entry);
        redoStack_.clear();
        return;
      }
    }

    undoStack_.push_back(std::move(entry));
    if (undoStack_.size() > maxEntries) {
      undoStack_.erase(undoStack_.begin(), undoStack_.begin() + static_cast<std::ptrdiff_t>(undoStack_.size() - maxEntries));
    }
    redoStack_.clear();
  }

  [[nodiscard]] bool canUndo() const { return !undoStack_.empty(); }
  [[nodiscard]] bool canRedo() const { return !redoStack_.empty(); }
  [[nodiscard]] std::size_t undoCount() const { return undoStack_.size(); }
  [[nodiscard]] std::size_t redoCount() const { return redoStack_.size(); }

  CommandHistoryEntry undo() {
    auto entry = undoStack_.back();
    undoStack_.pop_back();
    redoStack_.push_back(entry);
    return entry;
  }

  CommandHistoryEntry redo() {
    auto entry = redoStack_.back();
    redoStack_.pop_back();
    undoStack_.push_back(entry);
    return entry;
  }

  void clear() {
    undoStack_.clear();
    redoStack_.clear();
  }

  void clearRedo() { redoStack_.clear(); }

  [[nodiscard]] nlohmann::json statusJson() const {
    return {
        {"undoCount", undoCount()},
        {"redoCount", redoCount()},
        {"canUndo", canUndo()},
        {"canRedo", canRedo()},
    };
  }

 private:
  std::vector<CommandHistoryEntry> undoStack_;
  std::vector<CommandHistoryEntry> redoStack_;
};

}  // namespace ai_editor
