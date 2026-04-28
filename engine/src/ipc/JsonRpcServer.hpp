#pragma once

#include "app/EngineApp.hpp"

#include <iostream>
#include <nlohmann/json.hpp>
#include <string>

namespace ai_editor {

class JsonRpcServer {
 public:
  explicit JsonRpcServer(EngineApp& app) : app_(app) {}

  void run(std::istream& input, std::ostream& output) {
    std::string line;
    while (std::getline(input, line)) {
      if (line.empty()) {
        continue;
      }

      output << handleLine(line).dump() << '\n';
      output.flush();
    }
  }

 private:
  nlohmann::json handleLine(const std::string& line) {
    nlohmann::json id = nullptr;

    try {
      const auto request = nlohmann::json::parse(line);
      id = request.value("id", nlohmann::json(nullptr));
      return {
          {"jsonrpc", "2.0"},
          {"id", id},
          {"result", app_.handleRequest(request)},
      };
    } catch (const std::exception& error) {
      return {
          {"jsonrpc", "2.0"},
          {"id", id},
          {"error",
           {
               {"code", -32000},
               {"message", error.what()},
           }},
      };
    }
  }

  EngineApp& app_;
};

}  // namespace ai_editor
