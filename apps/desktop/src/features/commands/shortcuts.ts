export interface ShortcutDefinition {
  id: string;
  group: "Playback" | "Timeline" | "Project" | "Navigation";
  command: string;
  keys: string;
  editable: boolean;
}

export type ShortcutMap = Record<string, string>;

export const shortcutDefinitions: ShortcutDefinition[] = [
  { id: "play_pause", group: "Playback", command: "Play / Pause", keys: "Space", editable: true },
  { id: "split", group: "Timeline", command: "Split at Playhead", keys: "S", editable: true },
  { id: "delete", group: "Timeline", command: "Delete Selected Clip", keys: "Delete", editable: true },
  { id: "ripple_delete", group: "Timeline", command: "Ripple Delete Selected Clip", keys: "Shift + Delete", editable: true },
  { id: "nudge_left", group: "Timeline", command: "Nudge Clip Left", keys: "Alt + Left", editable: true },
  { id: "nudge_right", group: "Timeline", command: "Nudge Clip Right", keys: "Alt + Right", editable: true },
  { id: "toggle_snapping", group: "Timeline", command: "Toggle Snapping", keys: "N", editable: true },
  { id: "zoom_timeline", group: "Timeline", command: "Timeline Zoom", keys: "Shift + Scroll", editable: false },
  { id: "save", group: "Project", command: "Save", keys: "Ctrl + S", editable: true },
  { id: "undo", group: "Project", command: "Undo", keys: "Ctrl + Z", editable: true },
  { id: "redo", group: "Project", command: "Redo", keys: "Ctrl + Shift + Z", editable: true },
  { id: "import", group: "Project", command: "Import Media", keys: "Ctrl + I", editable: true },
  { id: "export", group: "Project", command: "Export", keys: "Ctrl + E", editable: true },
  { id: "open_logs", group: "Navigation", command: "Open Logs", keys: "Ctrl + L", editable: true },
  { id: "command_search", group: "Navigation", command: "Command Search", keys: "Ctrl + K", editable: true }
];

const shortcutStorageKey = "ai-video-editor.shortcuts.v1";

export function defaultShortcutMap(): ShortcutMap {
  return Object.fromEntries(shortcutDefinitions.map((shortcut) => [shortcut.id, shortcut.keys]));
}

export function loadShortcutMap(): ShortcutMap {
  try {
    const stored = JSON.parse(localStorage.getItem(shortcutStorageKey) ?? "{}") as Record<string, unknown>;
    const storedShortcuts = Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return {
      ...defaultShortcutMap(),
      ...storedShortcuts
    };
  } catch {
    return defaultShortcutMap();
  }
}

export function saveShortcutMap(shortcuts: ShortcutMap) {
  localStorage.setItem(shortcutStorageKey, JSON.stringify(shortcuts));
}

export function resetShortcutMap() {
  const defaults = defaultShortcutMap();
  saveShortcutMap(defaults);
  return defaults;
}

export function shortcutFor(shortcuts: ShortcutMap, id: string) {
  return shortcuts[id] ?? defaultShortcutMap()[id] ?? "";
}

export function eventToShortcut(event: KeyboardEvent) {
  const key = normalizeEventKey(event);
  if (!key) {
    return "";
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.metaKey) {
    parts.push("Meta");
  }
  parts.push(key);
  return parts.join(" + ");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  if (!shortcut) {
    return false;
  }
  return normalizeShortcut(eventToShortcut(event)) === normalizeShortcut(shortcut);
}

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function normalizeEventKey(event: KeyboardEvent) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
    return "";
  }
  if (event.key === " ") {
    return "Space";
  }
  if (event.key.startsWith("Arrow")) {
    return event.key.replace("Arrow", "");
  }
  if (event.key.length === 1) {
    return event.key.toUpperCase();
  }
  if (event.key === "Esc") {
    return "Escape";
  }
  return event.key;
}

function normalizeShortcut(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => shortcutPartOrder(left) - shortcutPartOrder(right) || left.localeCompare(right))
    .join("+");
}

function shortcutPartOrder(part: string) {
  if (part === "ctrl") {
    return 0;
  }
  if (part === "shift") {
    return 1;
  }
  if (part === "alt") {
    return 2;
  }
  if (part === "meta") {
    return 3;
  }
  return 4;
}
