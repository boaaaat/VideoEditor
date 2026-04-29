import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"));
const assetProtocol = config?.app?.security?.assetProtocol;

if (!assetProtocol?.enable) {
  throw new Error("Tauri asset protocol must be enabled so imported timeline media can play in the preview video element.");
}

const scope = assetProtocol.scope;
if (!Array.isArray(scope) || !scope.includes("**")) {
  throw new Error('Tauri asset protocol scope must include "**" for arbitrary user-selected editor media.');
}

console.log("Playback asset protocol config OK.");
