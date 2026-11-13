import { Link } from "react-router-dom";
import type { ReactElement } from "react";

export function AuthLegalNotice(): ReactElement {
  return (
    <p className="mv-authx__foot">
      <Link to="/help">Help &amp; support</Link>
    </p>
  );
}
