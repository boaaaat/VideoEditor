import { useEffect, useState, type ChangeEvent, type InputHTMLAttributes } from "react";

interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  value: number;
}

export function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  const [numberDraft, setNumberDraft] = useState(String(value));
  const inputProps = onChange ? { value, onChange } : { defaultValue: value };

  useEffect(() => {
    setNumberDraft(String(value));
  }, [value]);

  function handleNumberChange(event: ChangeEvent<HTMLInputElement>) {
    setNumberDraft(event.target.value);
    const nextValue = Number(event.target.value);
    if (Number.isFinite(nextValue)) {
      onChange?.(event);
    }
  }

  function resetInvalidDraft() {
    if (!Number.isFinite(Number(numberDraft))) {
      setNumberDraft(String(value));
    }
  }

  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} {...inputProps} />
      <input
        className="slider-number"
        type="number"
        min={min}
        max={max}
        step={step}
        value={numberDraft}
        onChange={handleNumberChange}
        onBlur={resetInvalidDraft}
      />
    </label>
  );
}
