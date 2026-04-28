#pragma once

#include <iostream>
#include <string>

namespace ai_editor {

class Logger {
 public:
  void info(const std::string& message) const {
    std::cerr << "[info] " << message << '\n';
  }

  void error(const std::string& message) const {
    std::cerr << "[error] " << message << '\n';
  }
};

}  // namespace ai_editor
