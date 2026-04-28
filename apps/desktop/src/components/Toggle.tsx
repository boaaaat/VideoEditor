import type { InputHTMLAttributes } from "react";

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: string;
}

export function Toggle({ label, checked, onChange }: ToggleProps) {
  const inputProps = onChange ? { checked, onChange } : { defaultChecked: checked };

  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" {...inputProps} />
    </label>
  );
}
