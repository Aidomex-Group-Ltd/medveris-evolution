import { useState } from "react";
import { Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Table } from "@medveris/ui";
import { useQuery } from "../lib/useQuery";

interface PayrollGrade { code: string; name: string; gradeLevel: number; description?: string; active: boolean }
interface Department { code: string; name: string; description?: string; sortOrder: number; active: boolean }

export function PayrollPage() {
  const [query, setQuery] = useState("");
  const grades = useQuery<{ payrollGrades: PayrollGrade[] }>(`/reference/payroll-grades${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  const departments = useQuery<{ departments: Department[] }>("/reference/departments");

  return (
    <div className="mv-stack">
      <PageHeader eyebrow="People" title="Payroll and HR" description="Global payroll grades and departments. Payroll is independent from professional cadres and specialties." />
      <Card title="Payroll grades" description={`${grades.data?.payrollGrades.length ?? 0} reference grades.`}>
        <Field label="Search grades" htmlFor="payroll-search"><Input id="payroll-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search code or name…" /></Field>
        {grades.loading ? <LoadingState /> : grades.error ? <ErrorState message={grades.error} onRetry={grades.reload} /> : !grades.data?.payrollGrades.length ? <EmptyState title="No grades" description="Try a different search." /> : (
          <Table head={["Code", "Grade", "Level"]} caption="Payroll grades">
            {grades.data.payrollGrades.map((g) => <tr key={g.code}><td className="mv-id">{g.code}</td><td><strong>{g.name}</strong>{g.description ? <div className="mv-small mv-muted">{g.description}</div> : null}</td><td>{g.gradeLevel}</td></tr>)}
          </Table>
        )}
      </Card>
      <Card title="Departments" description={`${departments.data?.departments.length ?? 0} reference departments.`}>
        {departments.loading ? <LoadingState /> : departments.error ? <ErrorState message={departments.error} onRetry={departments.reload} /> : !departments.data?.departments.length ? <EmptyState title="No departments" description="The department catalogue is empty." /> : (
          <Table head={["Code", "Department", "Order"]} caption="Departments">
            {departments.data.departments.map((d) => <tr key={d.code}><td className="mv-id">{d.code}</td><td><strong>{d.name}</strong>{d.description ? <div className="mv-small mv-muted">{d.description}</div> : null}</td><td>{d.sortOrder}</td></tr>)}
          </Table>
        )}
      </Card>
      <Notice>Staff payroll assignments are managed per facility and never change professional classification.</Notice>
    </div>
  );
}
