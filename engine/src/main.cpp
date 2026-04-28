#include "app/EngineApp.hpp"
#include "ipc/JsonRpcServer.hpp"

#include <iostream>
#include <string>

int main(int argc, char** argv) {
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
