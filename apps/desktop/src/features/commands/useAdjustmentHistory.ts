import { useRef } from "react";

/** Coalesce a continuous adjustment, while keeping different controls and later gestures undoable. */
export function useAdjustmentHistory() {
  const current = useRef({ key: "", at: 0, group: "" });
  return (key: string) => {
    const now = performance.now();
    if (current.current.key !== key || now - current.current.at > 750) {
      current.current = { key, at: now, group: `${key}:${crypto.randomUUID()}` };
    } else current.current.at = now;
    return { mode: "replace" as const, group: current.current.group };
  };
}
