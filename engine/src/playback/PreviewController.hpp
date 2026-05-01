#pragma once

#include "platform/FfmpegLocator.hpp"
#include "platform/GpuDetector.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <exception>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <nlohmann/json.hpp>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <d3d11.h>
#include <dxgi1_4.h>
#include <windows.h>
#include <wrl/client.h>
#endif

namespace ai_editor {

struct PreviewRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
  double scaleFactor = 1.0;

  [[nodiscard]] nlohmann::json toJson() const {
    return {
        {"x", x},
        {"y", y},
        {"width", width},
        {"height", height},
        {"scaleFactor", scaleFactor},
    };
  }
};

struct PreviewState {
  std::string mediaId;
  std::string mediaPath;
  std::string codec = "unknown";
  std::string quality = "Proxy";
  std::string colorMode = "SDR";
  double fps = 30.0;
  std::int64_t playheadUs = 0;
  std::int64_t inUs = 0;
  std::int64_t outUs = 0;
  double playbackRate = 1.0;
  bool playing = false;
};

class PreviewController {
 public:
  explicit PreviewController(const FfmpegLocator& locator) : locator_(locator) {}

  nlohmann::json attach(const nlohmann::json& params, const GpuStatus& gpu) {
    parentHwnd_ = params.value("parentHwnd", std::string{});
    if (params.contains("rect")) {
      rect_ = parseRect(params.at("rect"));
    } else {
      rect_ = parseRect(params);
    }
    hdrOutputAvailable_ = params.value("hdrOutputAvailable", false);
    decodeMode_ = gpu.nvencAvailable ? "cuda/nvdec" : "software";
    statsStartedAt_ = std::chrono::steady_clock::now();
    createNativeSurface();
    return surfaceJson("attached");
  }

  nlohmann::json resize(const nlohmann::json& params) {
    if (params.contains("rect")) {
      rect_ = parseRect(params.at("rect"));
    } else {
      rect_ = parseRect(params);
    }
    resizeNativeSurface();
    return surfaceJson("resized");
  }

  nlohmann::json setState(const nlohmann::json& params) {
    const auto previousMediaPath = state_.mediaPath;
    state_.mediaId = params.value("mediaId", state_.mediaId);
    state_.mediaPath = params.value("mediaPath", state_.mediaPath);
    state_.codec = params.value("codec", state_.codec);
    state_.quality = params.value("quality", state_.quality);
    state_.colorMode = params.value("colorMode", state_.colorMode);
    state_.fps = params.value("fps", state_.fps);
    state_.playheadUs = params.value("playheadUs", state_.playheadUs);
    state_.inUs = params.value("inUs", state_.inUs);
    state_.outUs = params.value("outUs", state_.outUs);
    state_.playbackRate = params.value("playbackRate", state_.playbackRate);
    state_.playing = params.value("playing", state_.playing);
    if (previousMediaPath != state_.mediaPath) {
      resetDecodedFrame();
    }
    if (state_.mediaPath.empty()) {
      decodeMode_ = "idle";
    }
    if (state_.playing) {
      playbackStartedAt_ = std::chrono::steady_clock::now();
      playbackStartUs_ = state_.playheadUs;
    }
    return stats();
  }

  nlohmann::json play() {
    state_.playing = true;
    playbackStartedAt_ = std::chrono::steady_clock::now();
    playbackStartUs_ = state_.playheadUs;
    return stats();
  }

  nlohmann::json pause() {
    updatePlaybackPosition();
    state_.playing = false;
    return stats();
  }

  nlohmann::json seek(const nlohmann::json& params) {
    state_.playheadUs = params.value("playheadUs", state_.playheadUs);
    playbackStartedAt_ = std::chrono::steady_clock::now();
    playbackStartUs_ = state_.playheadUs;
    return stats();
  }

  nlohmann::json stats() {
    updatePlaybackPosition();
    updateDecodedFrame();
    const auto warning = warningMessage();
    return {
        {"attached", !parentHwnd_.empty()},
        {"parentHwnd", parentHwnd_},
        {"childHwnd", childHwnd_},
        {"rect", rect_.toJson()},
        {"state", state_.playing ? "playing" : "paused"},
        {"mediaId", state_.mediaId},
        {"mediaPath", state_.mediaPath},
        {"codec", state_.codec},
        {"decodeMode", decodeMode_},
        {"renderMode", renderMode_},
        {"frameNumber", frameNumber_},
        {"renderedFrames", renderedFrames_},
        {"frameDataUrl", frameDataUrl_},
        {"lastFramePlayheadUs", lastDecodedPlayheadUs_},
        {"lastFrameDecodeMs", lastFrameDecodeMs_},
        {"droppedFrames", droppedFrames_},
        {"previewFps", previewFps_},
        {"quality", state_.quality},
        {"colorMode", state_.colorMode},
        {"hdrOutputAvailable", hdrOutputAvailable_},
        {"warning", warning},
    };
  }

  [[nodiscard]] static std::vector<std::string> buildDecodeArgs(const std::string& mediaPath, std::int64_t seekUs) {
    return {
        "ffmpeg",
        "-hide_banner",
        "-hwaccel",
        "cuda",
        "-hwaccel_output_format",
        "cuda",
        "-ss",
        std::to_string(seekUs / 1'000'000.0),
        "-i",
        mediaPath,
    };
  }

 private:
  [[nodiscard]] static PreviewRect parseRect(const nlohmann::json& json) {
    PreviewRect rect;
    rect.x = static_cast<int>(json.value("x", 0.0));
    rect.y = static_cast<int>(json.value("y", 0.0));
    rect.width = std::max(0, static_cast<int>(json.value("width", 0.0)));
    rect.height = std::max(0, static_cast<int>(json.value("height", 0.0)));
    rect.scaleFactor = json.value("scaleFactor", 1.0);
    return rect;
  }

  nlohmann::json surfaceJson(const std::string& status) {
    return {
        {"status", status},
        {"attached", !parentHwnd_.empty()},
        {"parentHwnd", parentHwnd_},
        {"childHwnd", childHwnd_},
        {"rect", rect_.toJson()},
        {"renderMode", renderMode_},
        {"hdrOutputAvailable", hdrOutputAvailable_},
        {"warning", warningMessage()},
    };
  }

  void updatePlaybackPosition() {
    if (!state_.playing || state_.mediaPath.empty()) {
      previewFps_ = 0.0;
      return;
    }

    const auto now = std::chrono::steady_clock::now();
    const auto elapsed = std::chrono::duration<double>(now - playbackStartedAt_).count();
    if (elapsed <= 0.0) {
      return;
    }

    const auto playbackRate = std::isfinite(state_.playbackRate) && state_.playbackRate > 0.0 ? state_.playbackRate : 1.0;
    auto nextPlayheadUs = playbackStartUs_ + static_cast<std::int64_t>(elapsed * playbackRate * 1'000'000.0);
    if (state_.outUs > state_.inUs) {
      nextPlayheadUs = std::min(nextPlayheadUs, state_.outUs);
    }
    state_.playheadUs = std::max<std::int64_t>(0, nextPlayheadUs);
    const auto fps = state_.fps > 0.0 ? state_.fps : 30.0;
    frameNumber_ = static_cast<std::int64_t>(std::floor((state_.playheadUs / 1'000'000.0) * fps));
  }

  void updateDecodedFrame() {
    if (state_.mediaPath.empty()) {
      resetDecodedFrame();
      decodeMode_ = "idle";
      return;
    }

    const auto targetPlayheadUs = quantizeFrameTime(state_.playheadUs);
    if (targetPlayheadUs == lastDecodedPlayheadUs_ && state_.mediaPath == lastDecodedMediaPath_ && !frameDataUrl_.empty()) {
      return;
    }

    const auto ffmpeg = locator_.locate("ffmpeg");
    if (!ffmpeg.available) {
      frameDecodeWarning_ = ffmpeg.message.empty() ? "FFmpeg unavailable; preview decode is disabled." : ffmpeg.message;
      decodeMode_ = "idle";
      renderMode_ = "fallback";
      return;
    }

    const auto startedAt = std::chrono::steady_clock::now();
    try {
      const auto bytes = decodeFrame(ffmpeg.path, state_.mediaPath, targetPlayheadUs);
      const auto finishedAt = std::chrono::steady_clock::now();
      lastFrameDecodeMs_ = std::chrono::duration<double, std::milli>(finishedAt - startedAt).count();
      frameDataUrl_ = "data:image/png;base64," + base64Encode(bytes);
      lastDecodedMediaPath_ = state_.mediaPath;
      lastDecodedPlayheadUs_ = targetPlayheadUs;
      ++renderedFrames_;
      frameDecodeWarning_.clear();
      decodeMode_ = "engine/ffmpeg";
      renderMode_ = "engine-frame";
      previewFps_ = lastFrameDecodeMs_ > 0.0 ? std::min(state_.fps > 0.0 ? state_.fps : 30.0, 1000.0 / lastFrameDecodeMs_) : 0.0;
    } catch (const std::exception& error) {
      ++droppedFrames_;
      frameDecodeWarning_ = error.what();
      renderMode_ = "fallback";
      if (frameDataUrl_.empty()) {
        decodeMode_ = "idle";
      }
    }
  }

  [[nodiscard]] std::string warningMessage() const {
    if (!nativeSurfaceError_.empty()) {
      return nativeSurfaceError_;
    }
    if (state_.colorMode == "HDR" && !hdrOutputAvailable_) {
      return "HDR preview output unavailable; displaying SDR preview. HDR export remains available.";
    }
    if (!frameDecodeWarning_.empty()) {
      return frameDecodeWarning_;
    }
    if (decodeMode_ == "software") {
      return "GPU decode unavailable; preview may drop frames.";
    }
    return "";
  }

  [[nodiscard]] static std::int64_t quantizeFrameTime(std::int64_t playheadUs) {
    constexpr std::int64_t frameStepUs = 100'000;
    return std::max<std::int64_t>(0, (playheadUs / frameStepUs) * frameStepUs);
  }

  [[nodiscard]] std::vector<unsigned char> decodeFrame(const std::string& ffmpegPath, const std::string& mediaPath, std::int64_t playheadUs) const {
    const auto outputPath = std::filesystem::temp_directory_path() / ("ai-video-preview-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".png");
    const auto command = quoteArg(ffmpegPath) + " -hide_banner -loglevel error -y -ss " + formatSeconds(playheadUs) + " -i " + quoteArg(mediaPath) +
                         " -vf " + quoteArg(previewScaleFilter()) + " -frames:v 1 -f image2 -vcodec png " + quoteArg(outputPath.string()) + stderrRedirect();

    const auto exitCode = std::system(command.c_str());
    if (exitCode != 0 || !std::filesystem::is_regular_file(outputPath)) {
      std::filesystem::remove(outputPath);
      throw std::runtime_error("Engine preview decode failed.");
    }

    std::ifstream file(outputPath, std::ios::binary);
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    std::filesystem::remove(outputPath);
    if (bytes.empty()) {
      throw std::runtime_error("Engine preview decode produced an empty frame.");
    }
    return bytes;
  }

  static std::string formatSeconds(std::int64_t playheadUs) {
    std::ostringstream stream;
    stream << std::fixed << std::setprecision(3) << (std::max<std::int64_t>(0, playheadUs) / 1'000'000.0);
    return stream.str();
  }

  [[nodiscard]] std::string previewScaleFilter() const {
    const auto maxHeight = state_.quality == "Full" ? 1080 : 720;
    return "scale=-2:min(" + std::to_string(maxHeight) + "\\,ih)";
  }

  static std::string quoteArg(const std::string& value) {
    std::string escaped = "\"";
    for (const auto character : value) {
      if (character == '"') {
        escaped += "\\\"";
      } else {
        escaped += character;
      }
    }
    escaped += '"';
    return escaped;
  }

  static std::string stderrRedirect() {
#ifdef _WIN32
    return " 2>NUL";
#else
    return " 2>/dev/null";
#endif
  }

  static std::string base64Encode(const std::vector<unsigned char>& bytes) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve(((bytes.size() + 2) / 3) * 4);
    for (std::size_t index = 0; index < bytes.size(); index += 3) {
      const auto octetA = bytes[index];
      const auto octetB = index + 1 < bytes.size() ? bytes[index + 1] : 0;
      const auto octetC = index + 2 < bytes.size() ? bytes[index + 2] : 0;
      const auto triple = (static_cast<unsigned int>(octetA) << 16) | (static_cast<unsigned int>(octetB) << 8) | static_cast<unsigned int>(octetC);
      output.push_back(alphabet[(triple >> 18) & 0x3F]);
      output.push_back(alphabet[(triple >> 12) & 0x3F]);
      output.push_back(index + 1 < bytes.size() ? alphabet[(triple >> 6) & 0x3F] : '=');
      output.push_back(index + 2 < bytes.size() ? alphabet[triple & 0x3F] : '=');
    }
    return output;
  }

  void resetDecodedFrame() {
    frameDataUrl_.clear();
    lastDecodedMediaPath_.clear();
    lastDecodedPlayheadUs_ = -1;
    lastFrameDecodeMs_ = 0.0;
    frameDecodeWarning_.clear();
    renderedFrames_ = 0;
    renderMode_ = "fallback";
  }

  const FfmpegLocator& locator_;
  std::string parentHwnd_;
  std::string childHwnd_;
  std::string nativeSurfaceError_;
  std::string frameDecodeWarning_;
  std::string frameDataUrl_;
  std::string lastDecodedMediaPath_;
  PreviewRect rect_;
  PreviewState state_;
  std::string decodeMode_ = "idle";
  std::string renderMode_ = "fallback";
  bool hdrOutputAvailable_ = false;
  int droppedFrames_ = 0;
  double previewFps_ = 0.0;
  double lastFrameDecodeMs_ = 0.0;
  std::int64_t frameNumber_ = 0;
  std::int64_t renderedFrames_ = 0;
  std::int64_t lastDecodedPlayheadUs_ = -1;
  std::int64_t playbackStartUs_ = 0;
  std::chrono::steady_clock::time_point statsStartedAt_ = std::chrono::steady_clock::now();
  std::chrono::steady_clock::time_point playbackStartedAt_ = std::chrono::steady_clock::now();

#ifdef _WIN32
  Microsoft::WRL::ComPtr<ID3D11Device> d3dDevice_;
  Microsoft::WRL::ComPtr<ID3D11DeviceContext> d3dContext_;
  Microsoft::WRL::ComPtr<IDXGISwapChain1> swapChain_;
  Microsoft::WRL::ComPtr<ID3D11RenderTargetView> renderTargetView_;
  HWND childWindow_ = nullptr;

  void createNativeSurface() {
    nativeSurfaceError_.clear();
    if (!nativePreviewEmbeddingEnabled()) {
      return;
    }

    if (parentHwnd_.empty() || rect_.width <= 0 || rect_.height <= 0) {
      return;
    }

    try {
      const auto parent = parseHwnd(parentHwnd_);
      if (!parent) {
        nativeSurfaceError_ = "Native preview parent HWND is invalid.";
        return;
      }

      registerWindowClass();
      if (!childWindow_) {
        childWindow_ = CreateWindowExW(
            0,
            previewWindowClassName(),
            L"AI Video Editor Preview",
            WS_CHILD | WS_VISIBLE,
            rect_.x,
            rect_.y,
            std::max(1, rect_.width),
            std::max(1, rect_.height),
            parent,
            nullptr,
            GetModuleHandleW(nullptr),
            nullptr);
      }

      if (!childWindow_) {
        nativeSurfaceError_ = "Failed to create native preview child HWND.";
        return;
      }

      childHwnd_ = hwndToString(childWindow_);
      createD3dSwapChain();
      resizeNativeSurface();
    } catch (const std::exception& error) {
      nativeSurfaceError_ = error.what();
    }
  }

  void resizeNativeSurface() {
    if (!nativePreviewEmbeddingEnabled()) {
      return;
    }

    if (!childWindow_) {
      return;
    }

    SetWindowPos(
        childWindow_,
        nullptr,
        rect_.x,
        rect_.y,
        std::max(1, rect_.width),
        std::max(1, rect_.height),
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);

    if (swapChain_) {
      renderTargetView_.Reset();
      const auto resizeResult = swapChain_->ResizeBuffers(
          0,
          static_cast<UINT>(std::max(1, rect_.width)),
          static_cast<UINT>(std::max(1, rect_.height)),
          DXGI_FORMAT_UNKNOWN,
          0);
      if (FAILED(resizeResult)) {
        nativeSurfaceError_ = "Failed to resize D3D preview swap chain.";
        return;
      }
      createRenderTargetView();
      clearSurface();
    }
  }

  void createD3dSwapChain() {
    if (!d3dDevice_) {
      UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#ifdef _DEBUG
      flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
      D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_11_0;
      const D3D_FEATURE_LEVEL requestedLevels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
      auto result = D3D11CreateDevice(
          nullptr,
          D3D_DRIVER_TYPE_HARDWARE,
          nullptr,
          flags,
          requestedLevels,
          2,
          D3D11_SDK_VERSION,
          &d3dDevice_,
          &featureLevel,
          &d3dContext_);

#ifdef _DEBUG
      if (result == DXGI_ERROR_SDK_COMPONENT_MISSING) {
        flags &= ~D3D11_CREATE_DEVICE_DEBUG;
        result = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            flags,
            requestedLevels,
            2,
            D3D11_SDK_VERSION,
            &d3dDevice_,
            &featureLevel,
            &d3dContext_);
      }
#endif

      if (FAILED(result)) {
        nativeSurfaceError_ = "Failed to create D3D11 preview device.";
        return;
      }
    }

    if (swapChain_) {
      return;
    }

    Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
    Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
    Microsoft::WRL::ComPtr<IDXGIFactory2> factory;
    if (FAILED(d3dDevice_.As(&dxgiDevice)) || FAILED(dxgiDevice->GetAdapter(&adapter))) {
      nativeSurfaceError_ = "Failed to query DXGI adapter for preview.";
      return;
    }

    if (FAILED(adapter->GetParent(__uuidof(IDXGIFactory2), reinterpret_cast<void**>(factory.GetAddressOf())))) {
      nativeSurfaceError_ = "Failed to query DXGI factory for preview.";
      return;
    }

    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width = static_cast<UINT>(std::max(1, rect_.width));
    desc.Height = static_cast<UINT>(std::max(1, rect_.height));
    desc.Format = hdrOutputAvailable_ ? DXGI_FORMAT_R10G10B10A2_UNORM : DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.Stereo = FALSE;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = 2;
    desc.Scaling = DXGI_SCALING_STRETCH;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;

    const auto result = factory->CreateSwapChainForHwnd(d3dDevice_.Get(), childWindow_, &desc, nullptr, nullptr, &swapChain_);
    if (FAILED(result)) {
      nativeSurfaceError_ = "Failed to create D3D preview swap chain.";
      return;
    }

    if (hdrOutputAvailable_) {
      Microsoft::WRL::ComPtr<IDXGISwapChain3> hdrSwapChain;
      if (SUCCEEDED(swapChain_.As(&hdrSwapChain))) {
        hdrSwapChain->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020);
      }
    }

    createRenderTargetView();
    clearSurface();
  }

  void createRenderTargetView() {
    Microsoft::WRL::ComPtr<ID3D11Texture2D> backBuffer;
    if (FAILED(swapChain_->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(backBuffer.GetAddressOf())))) {
      nativeSurfaceError_ = "Failed to get D3D preview back buffer.";
      return;
    }

    if (FAILED(d3dDevice_->CreateRenderTargetView(backBuffer.Get(), nullptr, &renderTargetView_))) {
      nativeSurfaceError_ = "Failed to create D3D preview render target.";
    }
  }

  void clearSurface() {
    if (!d3dContext_ || !renderTargetView_ || !swapChain_) {
      return;
    }

    const float color[4] = {0.015f, 0.015f, 0.014f, 1.0f};
    d3dContext_->OMSetRenderTargets(1, renderTargetView_.GetAddressOf(), nullptr);
    d3dContext_->ClearRenderTargetView(renderTargetView_.Get(), color);
    swapChain_->Present(1, 0);
  }

  static HWND parseHwnd(const std::string& value) {
    try {
      const auto parsed = static_cast<std::uintptr_t>(std::stoull(value));
      return reinterpret_cast<HWND>(parsed);
    } catch (...) {
      return nullptr;
    }
  }

  static std::string hwndToString(HWND hwnd) {
    std::ostringstream stream;
    stream << reinterpret_cast<std::uintptr_t>(hwnd);
    return stream.str();
  }

  static void registerWindowClass() {
    static bool registered = false;
    if (registered) {
      return;
    }

    WNDCLASSEXW windowClass = {};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = DefWindowProcW;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.lpszClassName = previewWindowClassName();
    RegisterClassExW(&windowClass);
    registered = true;
  }

  static const wchar_t* previewWindowClassName() { return L"AiVideoEditorD3DPreviewWindow"; }

  static bool nativePreviewEmbeddingEnabled() {
    const auto* value = std::getenv("AI_VIDEO_ENABLE_NATIVE_D3D_PREVIEW");
    return value != nullptr && std::string(value) == "1";
  }
#else
  void createNativeSurface() {
    nativeSurfaceError_ = "Native D3D preview is only available on Windows.";
  }

  void resizeNativeSurface() {}
#endif
};

}  // namespace ai_editor
