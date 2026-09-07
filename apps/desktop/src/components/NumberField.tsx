import { useEffect, useState } from "react";

interface NumberFieldProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

/** Keep incomplete numeric input local; one committed change creates one undo step. */
export function NumberField({ label, value, min, max, step = 1, disabled, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    if (parsed === value) return;
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  }

  return <label className="number-field">
    <span>{label}</span>
    <input type="number" value={draft} min={min} max={max} step={step} disabled={disabled}
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(String(value)); event.stopPropagation(); }
      }} />
  </label>;
}
