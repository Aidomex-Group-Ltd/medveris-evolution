import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

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

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return <div className="mv-loading" role="status" aria-live="polite"><span className="mv-spinner" aria-hidden="true" />{label}…</div>;
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
