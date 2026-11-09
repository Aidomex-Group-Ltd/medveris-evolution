import { Fragment, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  busy?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  busy = false,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={`mv-button mv-button--${variant} mv-button--${size} ${busy ? "mv-button--busy" : ""} ${className}`} {...props} disabled={props.disabled || busy} />;
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

export function Input({ ref, className = "", ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }) {
  return <input ref={ref} className={`mv-input ${className}`.trim()} {...rest} />;
}

export function Textarea({ ref, className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={`mv-input mv-textarea ${className}`.trim()} {...rest} />;
}

export function Select({ ref, className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: React.Ref<HTMLSelectElement> }) {
  return <select ref={ref} className={`mv-input mv-select ${className}`.trim()} {...rest} />;
}

export interface SearchOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SearchOptionGroup {
  label: string;
  options: SearchOption[];
}

export function SearchSelect({
  options = [],
  groups,
  value,
  onChange,
  placeholder = "Search…",
  id,
  disabled = false,
  emptyMessage = "No matches",
  "aria-label": ariaLabel,
}: {
  options?: SearchOption[];
  /** Optional headings; search still matches across every group. */
  groups?: SearchOptionGroup[];
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
  const groupedOptions = useMemo(() => groups ?? [{ label: "", options }], [groups, options]);
  const selected = useMemo(
    () => groupedOptions.flatMap((group) => group.options).find((option) => option.value === value),
    [groupedOptions, value],
  );
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groupedOptions
      .map((group) => ({
        label: group.label,
        options: group.options.filter((option) =>
          !needle || `${option.label} ${option.description ?? ""} ${option.value}`.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.options.length > 0);
  }, [groupedOptions, query]);
  const filtered = useMemo(() => filteredGroups.flatMap((group) => group.options), [filteredGroups]);

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
          {filtered.length ? filteredGroups.map((group) => (
            <Fragment key={group.label || "options"}>
              {group.label ? <li className="mv-search-select__group" role="presentation">{group.label}</li> : null}
              {group.options.map((option) => {
                const index = filtered.indexOf(option);
                return (
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
                );
              })}
            </Fragment>
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

export interface FriendlyErrorProps {
  title?: string;
  message: string;
  tone?: "neutral" | "warning";
  /** Short, human hints (never field paths or machine codes). */
  hints?: string[];
  /** The request reference, shown small and muted under a disclosure. */
  reference?: string;
  onRetry?: () => void;
  retryLabel?: string;
  onBack?: () => void;
  backLabel?: string;
}

/**
 * The calm, plain-language error surface: a soft neutral/amber card, an icon, one short
 * sentence and one clear action. The machine reference lives in a muted disclosure so it
 * can be shared with support without shouting at the person using the app.
 */
export function FriendlyError({
  title = "Something needs another look",
  message,
  tone = "neutral",
  hints = [],
  reference,
  onRetry,
  retryLabel = "Try again",
  onBack,
  backLabel = "Go back",
}: FriendlyErrorProps) {
  return (
    <div className={`mv-friendly mv-friendly--${tone}`} role="alert" aria-live="polite">
      <span className="mv-friendly__icon" aria-hidden="true">i</span>
      <div className="mv-friendly__body">
        <strong className="mv-friendly__title">{title}</strong>
        <p className="mv-friendly__message">{message}</p>
        {hints.length ? (
          <ul className="mv-friendly__hints">
            {hints.map((hint) => <li key={hint}>{hint}</li>)}
          </ul>
        ) : null}
        {onRetry || onBack ? (
          <div className="mv-friendly__actions">
            {onRetry ? <Button variant="secondary" size="sm" onClick={onRetry}>{retryLabel}</Button> : null}
            {onBack ? <Button variant="ghost" size="sm" onClick={onBack}>{backLabel}</Button> : null}
          </div>
        ) : null}
        {reference ? (
          <details className="mv-friendly__details">
            <summary>Details</summary>
            <code className="mv-friendly__reference">{reference}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Compact toast variant for failures that happen after an action rather than on load. */
export function FriendlyErrorToast({ title, message, tone = "warning", reference }: Pick<FriendlyErrorProps, "title" | "message" | "tone" | "reference">) {
  return (
    <div className={`mv-friendly mv-friendly--toast mv-friendly--${tone}`} role="status" aria-live="polite">
      <span className="mv-friendly__icon" aria-hidden="true">i</span>
      <div className="mv-friendly__body">
        {title ? <strong className="mv-friendly__title">{title}</strong> : null}
        <p className="mv-friendly__message">{message}</p>
        {reference ? (
          <details className="mv-friendly__details">
            <summary>Details</summary>
            <code className="mv-friendly__reference">{reference}</code>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Backwards-compatible wrapper: existing pages get the friendly surface automatically. */
export function ErrorState({ title = "Something needs another look", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return <FriendlyError title={title} message={message} onRetry={onRetry} />;
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

export function Table({ head, children, caption, responsive = true }: { head: ReactNode[]; children: ReactNode; caption?: string; responsive?: boolean }) {
  return (
    <div className={`mv-table-wrap${responsive ? " mv-table-wrap--responsive" : ""}`}>
      <table className="mv-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead><tr>{head.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Responsive modal primitive. Desktop dialogs are centered; on small screens
 * the same content becomes a bottom sheet with safe-area padding.
 */
export function Dialog({ open, onClose, title, description, children, className = "" }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus({ preventScroll: true });

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose?.();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="mv-dialog">
      <button type="button" className="mv-dialog__scrim" aria-label="Close dialog" onClick={onClose} />
      <section
        ref={panelRef}
        className={`mv-dialog__panel ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="mv-dialog__head">
          <div>
            <h2>{title}</h2>
            {description ? <p className="mv-dialog__description">{description}</p> : null}
          </div>
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
              Close
            </Button>
          ) : null}
        </header>
        <div className="mv-dialog__body">{children}</div>
      </section>
    </div>
  );
}

export interface ChartFrameProps {
  title: string;
  description?: string;
  children: ReactNode;
  emptyTitle?: string;
  emptyMessage?: string;
  className?: string;
}

/**
 * Responsive chart container. Chart libraries should size to their parent;
 * this frame provides the viewport, touch scrolling, and minimum height.
 */
export function ChartFrame({ title, description, children, emptyTitle, emptyMessage, className = "" }: ChartFrameProps) {
  return (
    <section className={`mv-chart ${className}`.trim()} aria-label={title}>
      <header className="mv-chart__header">
        <div>
          <h3>{title}</h3>
          {description ? <p className="mv-chart__description">{description}</p> : null}
        </div>
      </header>
      <div className="mv-chart__viewport mv-scroll-x">
        {children}
        {emptyTitle ? <EmptyState title={emptyTitle} description={emptyMessage ?? "Chart data is not available yet."} /> : null}
      </div>
    </section>
  );
}
