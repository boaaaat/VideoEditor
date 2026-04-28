import type { InputHTMLAttributes } from "react";

interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
  value: number;
}

export function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  const inputProps = onChange ? { value, onChange } : { defaultValue: value };

  return (
    <label className="slider-row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} {...inputProps} />
      <output>{value}</output>
    </label>
  );
}
