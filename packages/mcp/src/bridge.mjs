import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function defaultBridgePath(env = process.env) {
  if (env.AI_VIDEO_EDITOR_BRIDGE_FILE) return env.AI_VIDEO_EDITOR_BRIDGE_FILE;
  if (!env.LOCALAPPDATA) throw new Error('Set AI_VIDEO_EDITOR_BRIDGE_FILE to the desktop bridge configuration path.');
  return join(env.LOCALAPPDATA, 'AI Video Editor', 'agent-bridge.json');
}

export function validateBridgeConfig(config) {
  const url = new URL(config.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/rpc' || url.username || url.password || url.search || url.hash) {
    throw new Error('The editor bridge must be an HTTP endpoint on 127.0.0.1.');
  }
  if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid editor bridge credentials. Re-enable agent access in the editor.');
  return { url: url.href, token: config.token };
}

export function createBridge({ configPath, fetchImpl = fetch } = {}) {
  return async function rpc(method, params = {}) {
    let config;
    try { config = validateBridgeConfig(JSON.parse(await readFile(configPath ?? defaultBridgePath(), 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Open AI Video Editor and enable agent access in the AI & Agents tab.');
      throw error;
    }
    let response;
    try {
      response = await fetchImpl(config.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(125_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({ method, params })
      });
    } catch {
      throw new Error('Editor connection failed or timed out. Check the app and inspect project state before retrying a mutation; its outcome may be uncertain.');
    }
    if (response.status === 503) throw new Error('Editor is still starting. Retry when the editor window is ready.');
    if (!response.ok) throw new Error(`Editor bridge rejected the request (HTTP ${response.status}). Re-enable agent access if the app restarted.`);
    const payload = await response.json();
    if (payload.error) throw new Error(String(payload.error));
    return payload.result;
  };
}
