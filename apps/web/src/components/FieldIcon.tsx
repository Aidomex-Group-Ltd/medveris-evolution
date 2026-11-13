import type { ReactElement } from "react";

export type FieldIconName =
  | "user" | "mail" | "phone" | "lock" | "search" | "map-pin" | "calendar" | "clock"
  | "wallet" | "hash" | "stethoscope" | "file-text" | "pill" | "flask" | "scan"
  | "building" | "users" | "droplet" | "credit-card";

/**
 * Inline leading-icon set for form fields, matching NavIcon's stroke language.
 * Icons are decorative: `aria-hidden` is always set because the associated label
 * already carries the field name. Size: 18px, aligned with 44px field height.
 */
export function FieldIcon({ name, size = 18, className }: { name: FieldIconName; size?: number; className?: string }): ReactElement {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false" as const,
    className,
  };

  switch (name) {
    case "user":
      return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
    case "mail":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 7 8.5 6 8.5-6" /></svg>;
    case "phone":
      return <svg {...common}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.8-3.8" /></svg>;
    case "map-pin":
      return <svg {...common}><path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></svg>;
    case "calendar":
      return <svg {...common}><rect x="4" y="6" width="16" height="15" rx="2" /><path d="M8 3v6M16 3v6M4 10h16" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>;
    case "wallet":
      return <svg {...common}><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" /><path d="M15 13h4v-3h-4a1.5 1.5 0 0 0 0 3Z" /></svg>;
    case "credit-card":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M7 15h4" /></svg>;
    case "hash":
      return <svg {...common}><path d="M9 4 7 20M17 4l-2 16M4.5 9h16M3.5 15h16" /></svg>;
    case "stethoscope":
      return <svg {...common}><path d="M5 3v6a4 4 0 0 0 8 0V3" /><path d="M9 15a6 6 0 0 0 12 0v-2" /><circle cx="21" cy="10.5" r="1.5" /><path d="M9 17h.01" /></svg>;
    case "file-text":
      return <svg {...common}><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M9 12h6M9 16h6M9 8h2" /></svg>;
    case "pill":
      return <svg {...common}><rect x="3.5" y="9" width="17" height="7" rx="3.5" transform="rotate(-45 12 12)" /><path d="M9 15l6-6" /></svg>;
    case "flask":
      return <svg {...common}><path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2L14 9V3" /></svg>;
    case "scan":
      return <svg {...common}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><circle cx="12" cy="12" r="3.5" /></svg>;
    case "building":
      return <svg {...common}><rect x="4" y="4" width="16" height="17" rx="1" /><path d="M9 9h2M13 9h2M9 13h2M13 13h2M10 21v-3h4v3" /></svg>;
    case "users":
      return <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="16.5" cy="9.5" r="2.6" /><path d="M15.5 14.2A5.2 5.2 0 0 1 21.5 19" /></svg>;
    case "droplet":
      return <svg {...common}><path d="M12 3s-6.5 7-6.5 11.5a6.5 6.5 0 0 0 13 0C18.5 10 12 3 12 3Z" /></svg>;
  }
}
