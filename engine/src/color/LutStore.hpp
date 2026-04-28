#pragma once

#include <filesystem>
#include <string>
#include <utility>

namespace ai_editor {

class LutStore {
 public:
  explicit LutStore(std::filesystem::path root) : root_(std::move(root)) {}

  [[nodiscard]] std::filesystem::path resolve(const std::string& lutId) const {
    return root_ / (lutId + ".cube");
  }

 private:
  std::filesystem::path root_;
};

}  // namespace ai_editor
