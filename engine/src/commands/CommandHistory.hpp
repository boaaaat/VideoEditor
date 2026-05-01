#pragma once

#include <string>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace ai_editor {

struct CommandHistoryEntry {
  std::string id;
  std::string type;
  nlohmann::json command;
  nlohmann::json beforeState;
  nlohmann::json afterState;
};

class CommandHistory {
 public:
  void push(CommandHistoryEntry entry) {
    undoStack_.push_back(std::move(entry));
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
