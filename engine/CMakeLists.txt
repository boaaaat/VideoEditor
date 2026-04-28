cmake_minimum_required(VERSION 3.24)

project(ai-video-engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(CTest)

find_package(nlohmann_json CONFIG REQUIRED)
find_package(unofficial-sqlite3 CONFIG REQUIRED)

add_library(ai-video-engine-core
  src/app/EngineApp.cpp
)

target_include_directories(ai-video-engine-core
  PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(ai-video-engine-core
  PUBLIC
    nlohmann_json::nlohmann_json
    unofficial::sqlite3::sqlite3
)

if(MSVC)
  target_compile_options(ai-video-engine-core PRIVATE /W4 /permissive-)
else()
  target_compile_options(ai-video-engine-core PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(ai-video-engine
  src/main.cpp
)

target_link_libraries(ai-video-engine
  PRIVATE ai-video-engine-core
)

if(BUILD_TESTING)
  add_executable(engine-core-tests
    tests/engine_core_tests.cpp
  )

  target_link_libraries(engine-core-tests
    PRIVATE ai-video-engine-core
  )

  add_test(NAME engine-core-tests COMMAND engine-core-tests)
endif()
