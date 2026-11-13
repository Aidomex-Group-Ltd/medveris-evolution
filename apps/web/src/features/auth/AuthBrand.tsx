import { Link } from "react-router-dom";
import type { ReactElement } from "react";
import { BrandMark } from "../../components/BrandMark";

export function AuthBrand(): ReactElement {
  return (
    <Link to="/" className="mv-authx__brand" aria-label="Medveris home">
      <BrandMark />
      <span className="mv-authx__wordmark">Medveris</span>
    </Link>
  );
}
