import type { ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
}

export function Tabs<T extends string>({ items, activeId, onChange }: TabsProps<T>) {
  return (
    <nav className="tabs" aria-label="Workspace tabs">
      {items.map((item) => (
        <button
          key={item.id}
          className={item.id === activeId ? "tab tab-active" : "tab"}
          onClick={() => onChange(item.id)}
          type="button"
        >
          {item.icon ? <span className="tab-icon">{item.icon}</span> : null}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
