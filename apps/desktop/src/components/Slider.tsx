import { useEffect, useState, type ChangeEvent, type InputHTMLAttributes } from "react";

interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  value: number;
}

export function Slider({ label, value, min, max, step, onChange, disabled, ...props }: SliderProps) {
  const [numberDraft, setNumberDraft] = useState(String(value));
  const inputProps = onChange ? { value, onChange } : { defaultValue: value };

  useEffect(() => {
    setNumberDraft(String(value));
  }, [value]);

  function handleNumberChange(event: ChangeEvent<HTMLInputElement>) {
    setNumberDraft(event.target.value);
    const nextValue = Number(event.target.value);
    if (event.target.value.trim() && Number.isFinite(nextValue)) {
      const clamped = Math.min(max === undefined ? Infinity : Number(max), Math.max(min === undefined ? -Infinity : Number(min), nextValue));
      if (clamped !== nextValue) return;
      onChange?.(event);
    }
  }

  function resetInvalidDraft() {
    const number = Number(numberDraft);
    if (!numberDraft.trim() || !Number.isFinite(number) || (min !== undefined && number < Number(min)) || (max !== undefined && number > Number(max))) {
      setNumberDraft(String(value));
    }
  }

  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} disabled={disabled} {...props} {...inputProps} />
      <input
        className="slider-number"
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={`${label} value`}
        value={numberDraft}
        onChange={handleNumberChange}
        onBlur={resetInvalidDraft}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      />
    </label>
  );
}
