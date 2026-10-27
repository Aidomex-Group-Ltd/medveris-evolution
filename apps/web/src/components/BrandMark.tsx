import type { ReactElement } from "react";

export function BrandMark(): ReactElement {
  return (
    <span className="mv-brand__mark" aria-hidden="true">
      <img src="/logo.png" alt="" width={256} height={256} decoding="async" />
    </span>
  );
}
