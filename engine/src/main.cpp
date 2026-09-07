#include "app/EngineApp.hpp"
#include "ipc/JsonRpcServer.hpp"
#include "plugins/NativePluginHost.hpp"

#include <iostream>
#include <string>

int main(int argc, char** argv) {
  if (argc > 1 && std::string(argv[1]) == "--run-plugin") {
    try {
      std::string input;
      std::getline(std::cin, input);
      if (input.size() > 2 * 1024 * 1024) throw std::runtime_error("Plugin input exceeds 2 MB");
      const auto request = nlohmann::json::parse(input);
      const auto entry = std::filesystem::u8path(request.at("entry").get<std::string>());
      std::cout << ai_editor::NativePluginHost::run(entry, request.at("context")).dump() << '\n';
      return 0;
    } catch (const std::exception& error) {
      std::cout << nlohmann::json{{"error", error.what()}}.dump() << '\n';
      return 0;
    }
  }
  ai_editor::EngineApp app;

  const bool stdioMode = argc > 1 && std::string(argv[1]) == "--stdio";
  if (stdioMode) {
    ai_editor::JsonRpcServer server(app);
    server.run(std::cin, std::cout);
    return 0;
  }

  std::cout << app.status().dump(2) << '\n';
  return 0;
}
