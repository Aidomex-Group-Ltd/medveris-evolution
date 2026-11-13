import { useState } from "react";
import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { Input } from "@medveris/ui";

/** Password input with a show/hide toggle. Never logs its value. */
export function PasswordField({
  id,
  autoComplete,
  icon,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { id: string; icon?: ReactNode }): ReactElement {
  const [visible, setVisible] = useState(false);
  return (
    <span className="mv-password-wrap">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        spellCheck={false}
        icon={icon}
        {...rest}
      />
      <button
        type="button"
        className="mv-password-toggle"
        aria-pressed={visible}
        aria-label={visible ? "Hide password" : "Show password"}
        onClick={() => setVisible((value) => !value)}
        tabIndex={0}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </span>
  );
}
