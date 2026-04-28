export interface ShortcutDefinition {
  id: string;
  group: "Playback" | "Timeline" | "Project" | "Navigation";
  command: string;
  keys: string;
  editable: boolean;
}

export const shortcutDefinitions: ShortcutDefinition[] = [
  { id: "play_pause", group: "Playback", command: "Play / Pause", keys: "Space", editable: false },
  { id: "split", group: "Timeline", command: "Split at Playhead", keys: "S", editable: false },
  { id: "delete", group: "Timeline", command: "Delete Selected Clip", keys: "Delete", editable: false },
  { id: "ripple_delete", group: "Timeline", command: "Ripple Delete Selected Clip", keys: "Shift + Delete", editable: false },
  { id: "nudge_left", group: "Timeline", command: "Nudge Clip Left", keys: "Alt + Left", editable: false },
  { id: "nudge_right", group: "Timeline", command: "Nudge Clip Right", keys: "Alt + Right", editable: false },
  { id: "toggle_snapping", group: "Timeline", command: "Toggle Snapping", keys: "N", editable: false },
  { id: "zoom_timeline", group: "Timeline", command: "Timeline Zoom", keys: "Shift + Scroll", editable: false },
  { id: "save", group: "Project", command: "Save", keys: "Ctrl + S", editable: false },
  { id: "undo", group: "Project", command: "Undo", keys: "Ctrl + Z", editable: false },
  { id: "redo", group: "Project", command: "Redo", keys: "Ctrl + Shift + Z", editable: false },
  { id: "import", group: "Project", command: "Import Media", keys: "Ctrl + I", editable: false },
  { id: "export", group: "Project", command: "Export", keys: "Ctrl + E", editable: false },
  { id: "command_search", group: "Navigation", command: "Command Search", keys: "Ctrl + K", editable: false }
];

export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
