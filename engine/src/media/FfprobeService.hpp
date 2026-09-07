#pragma once

#include "media/MediaMetadata.hpp"
#include "platform/FfmpegLocator.hpp"

#include <cstdio>
#include <cstdlib>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace ai_editor {

class FfprobeService {
 public:
  explicit FfprobeService(const FfmpegLocator& locator) : locator_(locator) {}

  [[nodiscard]] MediaMetadata probe(const std::string& path) const {
    if (path.empty() || path.find('\0') != std::string::npos || !std::filesystem::is_regular_file(std::filesystem::u8path(path))) {
      throw std::runtime_error("media file is missing or is not a regular file: " + path);
    }
    const auto ffprobe = locator_.locate("ffprobe");
    if (!ffprobe.available) {
      throw std::runtime_error(ffprobe.message);
    }

#ifdef _WIN32
    const auto output = runWindowsProbe(ffprobe.path, path);
#else
    const auto command = quoteArg(ffprobe.path) +
                         " -v error -print_format json -show_format -show_streams " +
                         quoteArg(path) + stderrRedirect();
    const auto output = runCommand(command);
#endif
    if (output.empty()) {
      throw std::runtime_error("ffprobe returned no metadata for " + path);
    }

    const auto metadata = parseProbeJson(path, nlohmann::json::parse(output));
    if ((!metadata.hasAudio && (metadata.width <= 0 || metadata.height <= 0)) || metadata.durationUs <= 0) {
      throw std::runtime_error("media has no usable video/audio stream or duration: " + path);
    }
    return metadata;
  }

  [[nodiscard]] static MediaMetadata parseProbeJson(const std::string& path, const nlohmann::json& root) {
    MediaMetadata metadata;
    metadata.path = path;

    const auto streams = root.value("streams", nlohmann::json::array());
    for (const auto& stream : streams) {
      const auto codecType = stream.value("codec_type", std::string{});
      if (codecType == "audio") {
        metadata.hasAudio = true;
        MediaAudioStream audioStream;
        audioStream.index = static_cast<int>(metadata.audioStreams.size());
        audioStream.codec = stream.value("codec_name", std::string{"unknown"});
        audioStream.channels = stream.value("channels", 0);
        if (stream.contains("tags") && stream.at("tags").is_object()) {
          audioStream.title = stream.at("tags").value("title", std::string{});
        }
        metadata.audioStreams.push_back(audioStream);
        continue;
      }

      if (codecType != "video" || metadata.width > 0 || (stream.contains("disposition") && stream.at("disposition").value("attached_pic", 0) != 0)) {
        continue;
      }

      metadata.width = stream.value("width", 0);
      metadata.height = stream.value("height", 0);
      metadata.codec = stream.value("codec_name", std::string{"unknown"});
      metadata.pixelFormat = stream.value("pix_fmt", std::string{"unknown"});
      metadata.colorTransfer = stream.value("color_transfer", std::string{"unknown"});
      metadata.fps = parseFrameRate(stream.value("avg_frame_rate", std::string{}));
      if (metadata.fps <= 0.0) {
        metadata.fps = parseFrameRate(stream.value("r_frame_rate", std::string{}));
      }

      metadata.durationUs = parseDurationUs(stream.contains("duration") ? stream.at("duration") : nlohmann::json{});
      const auto colorPrimaries = stream.value("color_primaries", std::string{});
      metadata.hdr = isHdrTransfer(metadata.colorTransfer) ||
                     (colorPrimaries == "bt2020" && metadata.pixelFormat.find("10") != std::string::npos);
    }

    if (metadata.durationUs <= 0 && root.contains("format")) {
      metadata.durationUs = parseDurationUs(root.at("format").contains("duration") ? root.at("format").at("duration") : nlohmann::json{});
    }

    auto extension = std::filesystem::path(path).extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
    metadata.isStillImage = extension == ".png" || extension == ".jpg" || extension == ".jpeg" || extension == ".bmp" || extension == ".webp";
    if (metadata.isStillImage) { metadata.durationUs = 5'000'000; metadata.hasAudio = false; }
    return metadata;
  }

 private:
#ifdef _WIN32
  static std::wstring utf16(const std::string& text) {
    const auto length = MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    std::wstring result(length, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), result.data(), length);
    return result;
  }

  static std::wstring windowsArgument(const std::string& text) {
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const auto ch : utf16(text)) {
      if (ch == L'\\') { ++slashes; continue; }
      result.append(ch == L'"' ? slashes * 2 + 1 : slashes, L'\\');
      result += ch;
      slashes = 0;
    }
    result.append(slashes * 2, L'\\');
    return result + L'"';
  }

  static std::string runWindowsProbe(const std::string& executable, const std::string& path) {
    // Launch directly: cmd.exe quoting and percent expansion can corrupt legitimate file paths.
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE readPipe = nullptr, writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &security, 0)) throw std::runtime_error("failed to create ffprobe pipe");
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    HANDLE nullFile = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = writePipe;
    startup.hStdError = nullFile;
    startup.hStdInput = nullFile;
    PROCESS_INFORMATION process{};
    auto command = windowsArgument(executable) + L" -v error -print_format json -show_format -show_streams " + windowsArgument(path);
    const auto started = CreateProcessW(utf16(executable).c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(writePipe);
    if (nullFile != INVALID_HANDLE_VALUE) CloseHandle(nullFile);
    if (!started) { CloseHandle(readPipe); throw std::runtime_error("failed to launch ffprobe"); }
    std::string output;
    char buffer[8192];
    DWORD bytes = 0;
    const auto start = std::chrono::steady_clock::now();
    std::string failure;
    for (;;) {
      DWORD available = 0;
      if (!PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr)) break;
      if (available > 0) {
        if (!ReadFile(readPipe, buffer, std::min<DWORD>(available, sizeof(buffer)), &bytes, nullptr) || !bytes) break;
        output.append(buffer, bytes);
        if (output.size() > 4 * 1024 * 1024) { failure = "ffprobe metadata exceeds 4 MB"; break; }
      } else {
        if (WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) break;
        // A process may write its last bytes while this wait completes. Drain them on the next iteration.
        WaitForSingleObject(process.hProcess, 10);
      }
      if (std::chrono::steady_clock::now() - start > std::chrono::seconds(15)) { failure = "ffprobe exceeded its 15 second time limit"; break; }
    }
    CloseHandle(readPipe);
    if (!failure.empty() || WaitForSingleObject(process.hProcess, 1000) != WAIT_OBJECT_0) {
      TerminateProcess(process.hProcess, 1);
      WaitForSingleObject(process.hProcess, 1000);
      if (failure.empty()) failure = "ffprobe did not finish";
    }
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (!failure.empty()) throw std::runtime_error(failure + ": " + path);
    if (exitCode != 0) throw std::runtime_error("ffprobe failed for " + path);
    return output;
  }
#endif

  static double parseFrameRate(const std::string& value) {
    if (value.empty() || value == "0/0") {
      return 0.0;
    }

    const auto slash = value.find('/');
    if (slash == std::string::npos) {
      return parseDouble(value);
    }

    const auto numerator = parseDouble(value.substr(0, slash));
    const auto denominator = parseDouble(value.substr(slash + 1));
    if (denominator == 0.0) {
      return 0.0;
    }

    return numerator / denominator;
  }

  static std::int64_t parseDurationUs(const nlohmann::json& value) {
    double seconds = 0.0;
    if (value.is_string()) {
      seconds = parseDouble(value.get<std::string>());
    } else if (value.is_number()) {
      seconds = value.get<double>();
    }

    return std::isfinite(seconds) && seconds > 0.0 && seconds <= 9'007'199'254.0 ? static_cast<std::int64_t>(seconds * 1'000'000.0) : 0;
  }

  static double parseDouble(const std::string& value) {
    char* end = nullptr;
    const auto parsed = std::strtod(value.c_str(), &end);
    return end == value.c_str() ? 0.0 : parsed;
  }

  static bool isHdrTransfer(const std::string& transfer) {
    return transfer == "smpte2084" || transfer == "arib-std-b67";
  }

  static std::string runCommand(const std::string& command) {
#ifdef _WIN32
    FILE* pipe = _popen(command.c_str(), "r");
#else
    FILE* pipe = popen(command.c_str(), "r");
#endif
    if (!pipe) {
      throw std::runtime_error("failed to run ffprobe");
    }

    std::ostringstream output;
    char buffer[4096];
    while (fgets(buffer, sizeof(buffer), pipe)) {
      output << buffer;
    }

#ifdef _WIN32
    const auto exitCode = _pclose(pipe);
#else
    const auto exitCode = pclose(pipe);
#endif
    if (exitCode != 0) {
      throw std::runtime_error("ffprobe failed");
    }

    return output.str();
  }

  static std::string quoteArg(const std::string& value) {
    std::string escaped = "'";
    for (const auto character : value) {
      if (character == '\'') {
        escaped += "'\\''";
      } else {
        escaped += character;
      }
    }
    escaped += '\'';
    return escaped;
  }

  static std::string stderrRedirect() {
#ifdef _WIN32
    return " 2>NUL";
#else
    return " 2>/dev/null";
#endif
  }

  const FfmpegLocator& locator_;
};

}  // namespace ai_editor
