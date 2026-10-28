import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "./BrandMark";

/** The two-column layout shared by the public account pages. */
export function AuthFrame({ eyebrow, heading, intro, children }: { eyebrow: string; heading: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="mv-auth">
      <section className="mv-auth__intro">
        <Link to="/" className="mv-brand" style={{ color: "inherit" }}>
          <BrandMark />
          <span>Medveris<small style={{ color: "#bcd7ce" }}>{eyebrow}</small></span>
        </Link>
        <div>
          <h1>{heading}</h1>
          <div style={{ marginTop: 16 }}>{intro}</div>
        </div>
        <p className="mv-small">Facility access always requires a verified staff assignment and two-step verification.</p>
      </section>
      <section className="mv-auth__panel">
        <div className="mv-auth__card mv-stack">{children}</div>
      </section>
    </div>
  );
}
