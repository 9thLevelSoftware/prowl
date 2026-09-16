"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "./ui";

export interface ComboOption {
  value: string;
  label: string;
  /** Extra searchable text (e.g. the model id). */
  keywords?: string;
  meta?: ReactNode;
  disabled?: boolean;
}

/**
 * Searchable single-select following the ARIA combobox pattern: type to filter, arrow keys to
 * move, Enter to pick, Escape to close. Handles lists of several hundred options.
 */
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  emptyText = "No matches",
  disabled,
  ariaLabel,
  className,
}: {
  options: ComboOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const terms = q.split(/\s+/);
    return options.filter((o) => {
      const hay = `${o.label} ${o.value} ${o.keywords ?? ""}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function openList() {
    if (disabled) return;
    setOpen(true);
    const i = filtered.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
  }
  function close() {
    setOpen(false);
    setQuery("");
  }
  function pick(o: ComboOption | undefined) {
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
    inputRef.current?.blur();
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <div className={cn("flex h-9 items-center rounded-md border border-border bg-panel focus-within:border-accent", disabled && "opacity-60")}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && filtered[active] ? `${id}-opt-${active}` : undefined}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          disabled={disabled}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-text placeholder:text-muted focus:outline-none"
          placeholder={selected ? selected.label : placeholder}
          value={open ? query : (selected?.label ?? "")}
          onFocus={openList}
          onClick={openList}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openList();
              else setActive((a) => Math.min(filtered.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              if (open) {
                e.preventDefault();
                pick(filtered[active]);
              }
            } else if (e.key === "Escape") {
              close();
            }
          }}
        />
        <button type="button" tabIndex={-1} aria-label="Show options" className="px-2 text-muted" onClick={() => (open ? close() : (inputRef.current?.focus(), openList()))} disabled={disabled}>
          <ChevronDown className="size-4" />
        </button>
      </div>
      {open ? (
        <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={ariaLabel} className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg">
          {filtered.length === 0 ? <li className="px-3 py-2 text-muted">{emptyText}</li> : null}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5", i === active && "bg-panel-2", o.disabled && "cursor-not-allowed opacity-50")}
            >
              <Check className={cn("size-3.5 shrink-0 text-accent", o.value === value ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.meta ? <span className="shrink-0 text-[12px] text-muted">{o.meta}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
