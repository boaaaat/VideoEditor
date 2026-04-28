#pragma once

#include <sstream>
#include <string>
#include <utility>

namespace ai_editor {

class PreviewServer {
 public:
  PreviewServer(std::string host, int port) : host_(std::move(host)), port_(port) {}

  std::string url() const {
    std::ostringstream stream;
    stream << "http://" << host_ << ':' << port_ << "/preview";
    return stream.str();
  }

 private:
  std::string host_;
  int port_;
};

}  // namespace ai_editor
