#pragma once

#include <string>
#include <vector>

namespace ai_editor {

struct CommandHistoryEntry {
  std::string id;
  std::string type;
};

class CommandHistory {
 public:
  void push(std::string id, std::string type) {
    undoStack_.push_back({std::move(id), std::move(type)});
    redoStack_.clear();
  }

  [[nodiscard]] std::size_t undoCount() const { return undoStack_.size(); }
  [[nodiscard]] std::size_t redoCount() const { return redoStack_.size(); }

 private:
  std::vector<CommandHistoryEntry> undoStack_;
  std::vector<CommandHistoryEntry> redoStack_;
};

}  // namespace ai_editor
