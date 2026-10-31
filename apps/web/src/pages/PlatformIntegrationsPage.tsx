import { PageHeader } from "@medveris/ui";
import { Integrations } from "./AdminPage";

export function PlatformIntegrationsPage() {
  return (
    <div className="mv-stack">
      <PageHeader eyebrow="Platform operations" title="Integrations" description="Adapter state is reported by this runtime. Only a passing conformance run makes a requested integration available." />
      <Integrations />
    </div>
  );
}
