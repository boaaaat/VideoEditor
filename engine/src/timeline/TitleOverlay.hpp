#pragma once
#include <cstdint>
#include <cmath>
#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <string>
#include <nlohmann/json.hpp>

namespace ai_editor {
struct TitleOverlay {
  std::string id;
  std::string text;
  std::int64_t startUs = 0;
  std::int64_t durationUs = 3'000'000;
  int fontSize = 48;
  std::string color = "#ffffff";
  double positionX = 50;
  double positionY = 80;
  bool background = true;
  std::string kind = "title";
};
inline void to_json(nlohmann::json& value, const TitleOverlay& title) {
  value = {{"id", title.id}, {"text", title.text}, {"startUs", title.startUs}, {"durationUs", title.durationUs}, {"fontSize", title.fontSize}, {"color", title.color}, {"positionX", title.positionX}, {"positionY", title.positionY}, {"background", title.background}};
  value["kind"] = title.kind;
}
inline void from_json(const nlohmann::json& value, TitleOverlay& title) {
  for (const auto* key : {"startUs", "durationUs", "fontSize"}) if (value.contains(key) && !value.at(key).is_number_integer()) throw std::runtime_error("title times and font size must be integers");
  title.id = value.at("id").get<std::string>();
  title.text = value.at("text").get<std::string>();
  title.startUs = value.value("startUs", 0LL);
  title.durationUs = value.value("durationUs", 3'000'000LL);
  title.fontSize = value.value("fontSize", 48);
  title.color = value.value("color", std::string{"#ffffff"});
  title.positionX = value.value("positionX", 50.0);
  title.positionY = value.value("positionY", 80.0);
  title.background = value.value("background", true);
  title.kind = value.value("kind", std::string{"title"});
  if (title.kind != "title" && title.kind != "caption") throw std::runtime_error("title kind must be title or caption");
  if (title.id.empty() || title.text.empty() || title.text.size() > 4'000 || title.text.find('\0') != std::string::npos || title.startUs < 0 || title.durationUs <= 0 || title.startUs > 9'007'199'254'740'991LL - title.durationUs) throw std::runtime_error("invalid title text or timing");
  if (title.fontSize < 10 || title.fontSize > 300 || !std::isfinite(title.positionX) || !std::isfinite(title.positionY) || title.positionX < 0 || title.positionX > 100 || title.positionY < 0 || title.positionY > 100) throw std::runtime_error("invalid title font size or position");
  if (title.color.size() != 7 || title.color[0] != '#' || !std::all_of(title.color.begin() + 1, title.color.end(), [](unsigned char ch) { return std::isxdigit(ch); })) throw std::runtime_error("title color must be #RRGGBB");
}
}
