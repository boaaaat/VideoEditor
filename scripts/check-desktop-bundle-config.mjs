import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const resources = config?.bundle?.resources;

if (resources?.["resources/ai-video-engine.exe"] !== "ai-video-engine.exe") {
  throw new Error("The desktop bundle must include ai-video-engine.exe at the resource root.");
}
if (resources?.["resources/sqlite3.dll"] !== "sqlite3.dll") {
  throw new Error("The desktop bundle must include the SQLite runtime beside the engine executable.");
}

const developmentScript = readFileSync("scripts/dev-desktop.ps1", "utf8");
if (!/stage-engine\.ps1" -Configuration Debug/.test(developmentScript)) {
  throw new Error("Desktop development must stage the Debug engine before Tauri starts.");
}

const releaseScript = readFileSync("scripts/build-desktop.ps1", "utf8");
if (!/build-engine\.ps1" -Configuration Release/.test(releaseScript) || !/stage-engine\.ps1" -Configuration Release/.test(releaseScript)) {
  throw new Error("Desktop packaging must build and stage the Release engine.");
}

console.log("Desktop engine bundle config OK.");
