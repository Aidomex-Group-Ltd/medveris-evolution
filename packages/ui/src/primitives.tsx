import { useId, useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" }) {
  return <button type={type} className={`mv-button mv-button--${variant} mv-button--${size} ${className}`} {...props} />;
}

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <label className="mv-field" htmlFor={htmlFor}>
      <span className="mv-field__label">{label}</span>
      {children}
      {hint ? <span className="mv-field__hint">{hint}</span> : null}
      {error ? <span className="mv-field__error" role="alert">{error}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="mv-input" {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="mv-input mv-textarea" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="mv-input mv-select" {...props} />;
}

export interface SearchOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Search…",
  id,
  disabled = false,
  emptyMessage = "No matches",
  "aria-label": ariaLabel,
}: {
  options: SearchOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  emptyMessage?: string;
  "aria-label"?: string;
}) {
  const generatedId = useId();
  const listId = `${id ?? generatedId}-listbox`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""} ${option.value}`.toLowerCase().includes(needle),
    );
  }, [options, query]);

  function commit(option: SearchOption | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && filtered[active]) {
        event.preventDefault();
        commit(filtered[active]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="mv-search-select">
      <input
        id={id}
        className="mv-input"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={open ? query : selected?.label ?? ""}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {selected && !open ? (
        <button
          type="button"
          className="mv-search-select__clear"
          aria-label={`Clear ${selected.label}`}
          onClick={() => {
            onChange("");
            setQuery("");
          }}
        >
          ×
        </button>
      ) : null}
      {open ? (
        <ul id={listId} className="mv-search-select__list" role="listbox" aria-label={ariaLabel ?? "Options"}>
          {filtered.length ? filtered.map((option, index) => (
            <li
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={`mv-search-select__option${index === active ? " is-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                commit(option);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <strong>{option.label}</strong>
              {option.description ? <span className="mv-small mv-muted">{option.description}</span> : null}
            </li>
          )) : <li className="mv-search-select__option mv-muted" role="presentation">{emptyMessage}</li>}
        </ul>
      ) : null}
    </div>
  );
}

export function Card({ title, description, actions, children, className = "" }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`mv-card ${className}`}>
      {title || actions ? (
        <header className="mv-card__header">
          <div>
            {title ? <h2 className="mv-card__title">{title}</h2> : null}
            {description ? <p className="mv-card__description">{description}</p> : null}
          </div>
          {actions ? <div className="mv-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`mv-badge mv-badge--${tone}`}>{children}</span>;
}

export function PageHeader({ title, eyebrow, description, actions }: { title: string; eyebrow?: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="mv-page-header">
      <div>
        {eyebrow ? <p className="mv-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="mv-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="mv-page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mv-empty" role="status">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ width, height, className }: { width?: string; height?: string; className?: string }) {
  return <span className={`mv-skeleton${className ? ` ${className}` : ""}`} style={{ width, height }} aria-hidden="true" />;
}

const SKELETON_LINE_WIDTHS = ["92%", "78%", "86%", "64%", "88%", "72%"];

export interface LoadingStateProps {
  label?: string;
  variant?: "list" | "page";
  rows?: number;
}

export function LoadingState({ label = "Loading", variant = "list", rows = 4 }: LoadingStateProps) {
  const lines = Array.from({ length: Math.max(1, rows) }, (_, index) => SKELETON_LINE_WIDTHS[index % SKELETON_LINE_WIDTHS.length]);
  return (
    <div className={`mv-loading mv-loading--${variant}`} role="status" aria-live="polite" aria-busy="true">
      <span className="mv-sr-only">{label}…</span>
      {variant === "page" ? (
        <>
          <div className="mv-loading__header" aria-hidden="true">
            <Skeleton width="120px" height="0.75rem" />
            <Skeleton width="min(320px, 70%)" height="1.75rem" />
          </div>
          <div className="mv-loading__card" aria-hidden="true">
            <Skeleton width="40%" height="1.1rem" />
            {lines.map((width, index) => <Skeleton key={index} width={width} />)}
          </div>
        </>
      ) : (
        <div className="mv-loading__rows" aria-hidden="true">
          {lines.map((width, index) => <Skeleton key={index} width={width} />)}
        </div>
      )}
    </div>
  );
}

export function ErrorState({ title = "Unable to load", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="mv-alert mv-alert--danger" role="alert">
      <strong>{title}</strong>
      <p>{message}</p>
      {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <div className={`mv-alert mv-alert--${tone}`} role={tone === "danger" ? "alert" : "status"}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="mv-tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="tab" aria-selected={value === option.value} className={`mv-tab ${value === option.value ? "is-active" : ""}`} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function DataList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="mv-datalist">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Table({ head, children, caption }: { head: ReactNode[]; children: ReactNode; caption?: string }) {
  return (
    <div className="mv-table-wrap">
      <table className="mv-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead><tr>{head.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
