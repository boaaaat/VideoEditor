#pragma once

#include <filesystem>
#include <string>
#include <utility>
#include <vector>

namespace ai_editor {

struct PluginDescriptor {
  std::string id;
  std::string type;
  std::filesystem::path path;
  bool enabled = false;
};

class PluginManager {
 public:
  void add(PluginDescriptor plugin) { plugins_.push_back(std::move(plugin)); }
  [[nodiscard]] const std::vector<PluginDescriptor>& plugins() const { return plugins_; }

 private:
  std::vector<PluginDescriptor> plugins_;
};

}  // namespace ai_editor
