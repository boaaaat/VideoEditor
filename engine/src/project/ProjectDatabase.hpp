#pragma once

#include <filesystem>
#include <stdexcept>
#include <string>

#include <sqlite3.h>

namespace ai_editor {

class ProjectDatabase {
 public:
  void initialize(const std::filesystem::path& databasePath) const {
    sqlite3* db = nullptr;
    if (sqlite3_open(databasePath.string().c_str(), &db) != SQLITE_OK) {
      const std::string message = db ? sqlite3_errmsg(db) : "unknown sqlite error";
      sqlite3_close(db);
      throw std::runtime_error("failed to open project database: " + message);
    }

    try {
      exec(db, "PRAGMA journal_mode=WAL;");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          kind TEXT NOT NULL,
          duration_us INTEGER,
          width INTEGER,
          height INTEGER,
          fps REAL,
          linked INTEGER NOT NULL DEFAULT 1
        );
      )sql");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          track_index INTEGER NOT NULL,
          locked INTEGER NOT NULL DEFAULT 0,
          muted INTEGER NOT NULL DEFAULT 0,
          visible INTEGER NOT NULL DEFAULT 1
        );
      )sql");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS clips (
          id TEXT PRIMARY KEY,
          media_id TEXT NOT NULL,
          track_id TEXT NOT NULL,
          start_us INTEGER NOT NULL,
          in_us INTEGER NOT NULL,
          out_us INTEGER NOT NULL,
          FOREIGN KEY(media_id) REFERENCES media(id),
          FOREIGN KEY(track_id) REFERENCES tracks(id)
        );
      )sql");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS color_settings (
          clip_id TEXT PRIMARY KEY,
          brightness REAL NOT NULL DEFAULT 0,
          contrast REAL NOT NULL DEFAULT 0,
          saturation REAL NOT NULL DEFAULT 1,
          temperature REAL NOT NULL DEFAULT 0,
          tint REAL NOT NULL DEFAULT 0,
          lut_path TEXT,
          lut_strength REAL NOT NULL DEFAULT 1
        );
      )sql");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS command_history (
          id TEXT PRIMARY KEY,
          command_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      )sql");
      exec(db, R"sql(
        CREATE TABLE IF NOT EXISTS plugin_settings (
          plugin_id TEXT PRIMARY KEY,
          enabled INTEGER NOT NULL DEFAULT 0,
          settings_json TEXT NOT NULL DEFAULT '{}'
        );
      )sql");
    } catch (...) {
      sqlite3_close(db);
      throw;
    }

    sqlite3_close(db);
  }

 private:
  static void exec(sqlite3* db, const char* sql) {
    char* error = nullptr;
    if (sqlite3_exec(db, sql, nullptr, nullptr, &error) != SQLITE_OK) {
      const std::string message = error ? error : "unknown sqlite error";
      sqlite3_free(error);
      throw std::runtime_error("sqlite error: " + message);
    }
  }
};

}  // namespace ai_editor
