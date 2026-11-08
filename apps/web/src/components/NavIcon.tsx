import type { NavIconName } from "../lib/nav";

interface NavIconProps {
  name: NavIconName;
  size?: number;
  className?: string;
}

/**
 * Small inline icon set so navigation stays dependency-free and works in every responsive shell.
 * Icons are decorative; labels always accompany them.
 */
export function NavIcon({ name, size = 20, className }: NavIconProps) {
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
    case "dashboard":
    case "more":
      return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.4" /><rect x="14" y="3" width="7" height="7" rx="1.4" /><rect x="3" y="14" width="7" height="7" rx="1.4" /><rect x="14" y="14" width="7" height="7" rx="1.4" /></svg>;
    case "home":
      return <svg {...common}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></svg>;
    case "reception":
    case "documents":
      return <svg {...common}><path d="M7 4h10a1 1 0 0 1 1 1v15l-3-2-3 2-3-2-3 2V5a1 1 0 0 1 1-1Z" /><path d="M9 8h6M9 12h6" /></svg>;
    case "outpatient":
    case "care":
      return <svg {...common}><path d="M3 12h4l2-5 3 10 2-5h7" /></svg>;
    case "inpatient":
      return <svg {...common}><path d="M3 19V7" /><path d="M3 11h18v8" /><path d="M7 11V9a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" /><path d="M3 19h18" /></svg>;
    case "theatre":
      return <svg {...common}><circle cx="7" cy="7" r="2.5" /><circle cx="7" cy="17" r="2.5" /><path d="M9 8.5 20 17M9 15.5 20 7" /></svg>;
    case "diagnostics":
    case "laboratory":
      return <svg {...common}><path d="M9 3h6" /><path d="M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3" /><path d="M8 15h8" /></svg>;
    case "pharmacy":
      return <svg {...common}><path d="M10.5 3h3v5h5v3h-5v5h-3v-5h-5V8h5V3Z" /></svg>;
    case "chronic":
      return <svg {...common}><path d="M20.8 6.6a5 5 0 0 0-8.8-1.4A5 5 0 0 0 3.2 6.6C2 10.4 6 14.2 12 19c6-4.8 10-8.6 8.8-12.4Z" /></svg>;
    case "virtual":
      return <svg {...common}><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></svg>;
    case "iot":
      return <svg {...common}><path d="M4 9a12 12 0 0 1 16 0" /><path d="M7 12a8 8 0 0 1 10 0" /><path d="M10 15a3.5 3.5 0 0 1 4 0" /><circle cx="12" cy="19" r="1" /></svg>;
    case "facility":
    case "provider-directory":
      return <svg {...common}><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" /><path d="M15 10h4a1 1 0 0 1 1 1v10" /><path d="M2 21h20" /><path d="M8 8h3M8 12h3M8 16h3" /></svg>;
    case "administration":
      return <svg {...common}><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></svg>;
    case "intelligence":
    case "ai":
    case "sparkles":
      return <svg {...common}><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" /><path d="m19 14 .9 2.1 2.1.9-2.1.9L19 22l-.9-2.1-2.1-.9 2.1-.9L19 14Z" /></svg>;
    case "portal":
      return <svg {...common}><circle cx="12" cy="8" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0" /></svg>;
    case "patients":
    case "caregivers":
      return <svg {...common}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="18" cy="9" r="2.5" /><path d="M15.5 20a5.5 5.5 0 0 1 5.5-5" /></svg>;
    case "visits":
    case "calendar":
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="m9 15 2 2 4-4" /></svg>;
    case "queues":
      return <svg {...common}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></svg>;
    case "exchange":
      return <svg {...common}><path d="M4 8h13l-3-3M20 16H7l3 3" /></svg>;
    case "emergency":
      return <svg {...common}><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17h.01" /></svg>;
    case "maternity":
      return <svg {...common}><circle cx="12" cy="6" r="2.5" /><path d="M9 11a3 3 0 0 1 6 0v3h2v3h-2v4H9v-4H7v-3h2v-3Z" /></svg>;
    case "radiology":
    case "imaging":
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 4v16M4 12h16" /><circle cx="12" cy="12" r="2" /></svg>;
    case "inventory":
      return <svg {...common}><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></svg>;
    case "procurement":
      return <svg {...common}><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M3 4h2l2.4 10.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.2L21 7H6" /></svg>;
    case "organizations":
      return <svg {...common}><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M12 7.5V13M12 13 5 15.5M12 13l7 2.5" /></svg>;
    case "credentials":
      return <svg {...common}><rect x="3" y="6" width="18" height="13" rx="2" /><circle cx="9" cy="12" r="2.2" /><path d="M6 17a3.2 3.2 0 0 1 6 0M14 11h4M14 15h4" /></svg>;
    case "workforce":
    case "onboarding":
      return <svg {...common}><path d="M4 21V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v16" /><path d="M8 7h5M8 11h5M8 15h3" /><path d="M17 12h4v9h-4M2 21h20" /></svg>;
    case "finance":
      return <svg {...common}><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 9v6M18 9v6" /></svg>;
    case "pos":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" /></svg>;
    case "price-list":
      return <svg {...common}><path d="m20 12-8 8-8-8 8-8h8v8Z" /><circle cx="16" cy="8" r="1.2" /></svg>;
    case "subscription":
      return <svg {...common}><path d="M20 7H7a3 3 0 0 0 0 6h10a3 3 0 0 1 0 6H4" /><path d="m17 4 3 3-3 3M7 20l-3-3 3-3" /></svg>;
    case "security":
      return <svg {...common}><path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "reports":
    case "analytics":
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
    case "content":
    case "knowledge":
      return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h5v18H6a2 2 0 0 1-2-2V5Z" /><path d="M20 5a2 2 0 0 0-2-2h-5v18h5a2 2 0 0 0 2-2V5Z" /></svg>;
    case "devices":
      return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>;
    case "promotions":
      return <svg {...common}><path d="m3 11 16-6v14L3 13v-2Z" /><path d="M7 14v4a2 2 0 0 0 4 0v-2" /></svg>;
    case "merge":
      return <svg {...common}><path d="M4 4v5c0 3 2 5 5 5h6" /><path d="m12 11 3 3-3 3" /><path d="M4 20v-5c0-2 1-3.5 2.5-4" /></svg>;
    case "operations":
      return <svg {...common}><path d="M14.5 6.5 17.8 3l3.2 3.2-3.5 3.3a6 6 0 0 1-7.4 7.4l-5.8 3.4-1.6-1.6 3.4-5.8a6 6 0 0 1 7.4-7.4Z" /><circle cx="10.5" cy="13.5" r="2.5" /></svg>;
    case "store":
      return <svg {...common}><path d="M3 9 5 4h14l2 5" /><path d="M4 9v11h16V9" /><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M9 20v-5h6v5" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 5 5" /></svg>;
    case "bell":
      return <svg {...common}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 19a2 2 0 0 0 4 0" /></svg>;
    case "close":
      return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case "menu":
      return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    default:
      return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 8v4M12 16h.01" /></svg>;
  }
}
