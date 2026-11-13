import type { ReactNode } from "react";

/**
 * Shell for every authentication journey: pale forest-tinted background, content
 * centered and capped at 480px. All spacing/colour comes from the .mv-authx classes.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mv-authx">
      <div className="mv-authx__container">{children}</div>
    </main>
  );
}
