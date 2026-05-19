import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
}

interface Props<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Shown at the left of the trigger, e.g. "模型" */
  leadingLabel?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  /** Width style applied to the trigger button */
  widthClass?: string;
  /** Optional icon rendered before the current value */
  icon?: ReactNode;
  title?: string;
}

export default function Select<T extends string = string>({
  value,
  options,
  onChange,
  leadingLabel,
  placeholder = "请选择",
  disabled,
  widthClass = "",
  icon,
  title,
}: Props<T>) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={title}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors
            hover:bg-[var(--color-surface-hover)] disabled:opacity-50 disabled:cursor-not-allowed ${widthClass}`}
          style={{
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        >
          {leadingLabel && (
            <span style={{ color: "var(--color-text-muted)" }}>{leadingLabel}</span>
          )}
          {icon}
          <span className="flex-1 truncate text-left">
            {current ? current.label : <span style={{ color: "var(--color-text-muted)" }}>{placeholder}</span>}
          </span>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ color: "var(--color-text-muted)" }}>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-[200] min-w-[160px] max-h-[320px] overflow-y-auto rounded-lg shadow-xl p-1 text-xs
            data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0
            data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
          sideOffset={4}
          align="start"
          collisionPadding={12}
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <DropdownMenu.Item
                key={opt.value}
                onSelect={(e) => {
                  e.preventDefault();
                  onChange(opt.value);
                }}
                className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none
                  data-[highlighted]:bg-[var(--color-surface-hover)]"
                style={{
                  color: selected ? "var(--color-accent)" : "var(--color-text)",
                  fontWeight: selected ? 600 : 400,
                }}
              >
                <span className="w-3 text-center">{selected ? "✓" : ""}</span>
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.hint && (
                  <span className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
                    {opt.hint}
                  </span>
                )}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
