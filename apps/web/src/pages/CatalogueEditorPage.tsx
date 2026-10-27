import { useCallback, useEffect, useMemo, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Notice, PageHeader, Select, Table, Tabs, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { useAction } from "../lib/useAction";

interface CatalogueRegulator {
  id: string;
  code: string;
  name: string;
  regulatorType: string;
  country: string;
  verificationMode: string;
  website?: string;
  notes?: string;
}

interface CatalogueDepartment {
  id: string;
  code: string;
  name: string;
  description?: string;
  sortOrder: number;
}

interface CatalogueCadre {
  id: string;
  code: string;
  name: string;
  category: string;
  description?: string;
  regulatorCodes: string[];
  requiresRegistration: boolean;
}

interface CatalogueJobTitle {
  id: string;
  code: string;
  name: string;
  cadreCode: string;
  seniority: string;
  description?: string;
  departmentCodes: string[];
  requiresCredential: boolean;
  privilegeCodes: string[];
  suggestedSystemRoles: string[];
}

interface CatalogueSpecialty {
  id: string;
  code: string;
  name: string;
  cadreCodes: string[];
  departmentCodes: string[];
  description?: string;
}

interface OnboardingCatalogue {
  countryCode: string;
  version: number;
  notice: string;
  regulators: CatalogueRegulator[];
  departments: CatalogueDepartment[];
  cadres: CatalogueCadre[];
  jobTitles: CatalogueJobTitle[];
  specialties: CatalogueSpecialty[];
}

interface CatalogueVersion {
  id: string;
  countryCode: string;
  version: number;
  status: string;
  contentDigest: string;
  publishedAt: string | null;
}

export function CatalogueEditorPage() {
  const { me } = useAuth();
  const action = useAction();
  const isPlatformOperator = me?.platformRoles.includes("platform_operator") ?? false;
  const hasEditPermission = isPlatformOperator || (me?.activeTenant?.roles.includes("facility_admin") ?? false);

  if (!hasEditPermission) {
    return (
      <div className="mv-stack">
        <PageHeader title="Access Denied" />
        <Card>
          <Notice tone="warning" title="Permission Required">
            <p>You need platform operator or facility administrator permissions to edit the onboarding catalogue.</p>
          </Notice>
        </Card>
      </div>
    );
  }

  const catalogue = useQuery<{ source: string; countryCode: string; version: number; notice: string; catalogue: OnboardingCatalogue }>("/onboarding/catalogue");
  const versions = useQuery<{ versions: CatalogueVersion[] }>("/onboarding/catalogue/versions");
  const [tab, setTab] = useState<"overview" | "regulators" | "departments" | "cadres" | "titles" | "specialties" | "publish">("overview");
  const [editState, setEditState] = useState<EditState | null>(null);

  // Initialize edit state from catalogue data
  useEffect(() => {
    if (catalogue.data && !editState) {
      const regulators = catalogue.data.catalogue.regulators.map(assignIds);
      const departments = catalogue.data.catalogue.departments.map(assignIds);
      const cadres = catalogue.data.catalogue.cadres.map(assignIds);
      const jobTitles = catalogue.data.catalogue.jobTitles.map(assignIds);
      const specialties = catalogue.data.catalogue.specialties.map(assignIds);

      setEditState({
        countryCode: catalogue.data.catalogue.countryCode,
        version: catalogue.data.version,
        notice: catalogue.data.catalogue.notice,
        regulators,
        departments,
        cadres,
        jobTitles,
        specialties,
      });
    }
  }, [catalogue.data, editState]);

  const integrityIssues = useMemo(() => {
    if (!editState) return [];
    const issues: string[] = [];
    const regulatorCodes = new Set(editState.regulators.map(r => r.code));
    const departmentCodes = new Set(editState.departments.map(d => d.code));
    const cadreCodes = new Set(editState.cadres.map(c => c.code));

    // Check for duplicate codes
    for (const r of editState.regulators) {
      if (editState.regulators.filter(x => x.code === r.code).length > 1) {
        issues.push(`Duplicate regulator code: ${r.code}`);
      }
    }
    for (const d of editState.departments) {
      if (editState.departments.filter(x => x.code === d.code).length > 1) {
        issues.push(`Duplicate department code: ${d.code}`);
      }
    }
    for (const c of editState.cadres) {
      if (editState.cadres.filter(x => x.code === c.code).length > 1) {
        issues.push(`Duplicate cadre code: ${c.code}`);
      }
    }
    for (const t of editState.jobTitles) {
      if (editState.jobTitles.filter(x => x.code === t.code).length > 1) {
        issues.push(`Duplicate job title code: ${t.code}`);
      }
    }
    for (const s of editState.specialties) {
      if (editState.specialties.filter(x => x.code === s.code).length > 1) {
        issues.push(`Duplicate specialty code: ${s.code}`);
      }
    }

    // Check for unknown references
    for (const c of editState.cadres) {
      for (const regCode of c.regulatorCodes || []) {
        if (!regulatorCodes.has(regCode)) {
          issues.push(`Cadre ${c.code} references unknown regulator: ${regCode}`);
        }
      }
    }
    for (const t of editState.jobTitles) {
      if (!cadreCodes.has(t.cadreCode)) {
        issues.push(`Job title ${t.code} references unknown cadre: ${t.cadreCode}`);
      }
      for (const deptCode of t.departmentCodes || []) {
        if (!departmentCodes.has(deptCode)) {
          issues.push(`Job title ${t.code} references unknown department: ${deptCode}`);
        }
      }
    }
    for (const s of editState.specialties) {
      for (const cadreCode of s.cadreCodes || []) {
        if (!cadreCodes.has(cadreCode)) {
          issues.push(`Specialty ${s.code} references unknown cadre: ${cadreCode}`);
        }
      }
      for (const deptCode of s.departmentCodes || []) {
        if (!departmentCodes.has(deptCode)) {
          issues.push(`Specialty ${s.code} references unknown department: ${deptCode}`);
        }
      }
    }

    return issues;
  }, [editState]);

  const publishCatalogue = useCallback(async (asDraft: boolean = false) => {
    if (!editState) return;
    await action.run("publish-catalogue", async () => {
      const response = await api<{ catalogue: { version: number } }>("/onboarding/catalogue/publish", {
        method: "POST",
        body: {
          countryCode: editState.countryCode,
          version: editState.version,
          notice: editState.notice,
          content: editState,
          status: asDraft ? "draft" : "published"
        },
      });
      versions.reload();
      catalogue.reload();
      return `Catalogue ${asDraft ? "saved as draft" : "published"} - Version ${response.catalogue.version}`;
    });
  }, [editState, action, versions, catalogue]);

  const publishDraft = useCallback(async (id: string) => {
    await action.run(`publish-draft-${id}`, async () => {
      await api(`/onboarding/catalogue/${id}/publish`, {
        method: "POST",
        body: { reason: "Published from catalogue editor" }
      });
      versions.reload();
      catalogue.reload();
      return "Draft published successfully";
    });
  }, [action, versions, catalogue]);

  if (catalogue.loading || (isPlatformOperator && versions.loading)) {
    return <LoadingState />;
  }
  if (catalogue.error) {
    return <ErrorState message={catalogue.error} onRetry={catalogue.reload} />;
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Administration"
        title="Onboarding Catalogue Editor"
        description={isPlatformOperator ? "Edit, version and publish the Uganda onboarding catalogue." : "View the Uganda onboarding catalogue."}
      />
      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}

      {editState && (
        <>
          <Tabs
            label="Catalogue sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "regulators", label: `Regulators (${editState.regulators.length})` },
              { value: "departments", label: `Departments (${editState.departments.length})` },
              { value: "cadres", label: `Cadres (${editState.cadres.length})` },
              { value: "titles", label: `Job Titles (${editState.jobTitles.length})` },
              { value: "specialties", label: `Specialties (${editState.specialties.length})` },
              { value: "publish", label: "Publish" },
            ]}
          />

          {tab === "overview" && (
            <OverviewTab
              state={editState}
              setState={setEditState}
              integrityIssues={integrityIssues}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "regulators" && (
            <RegulatorsTab
              state={editState}
              setState={setEditState}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "departments" && (
            <DepartmentsTab
              state={editState}
              setState={setEditState}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "cadres" && (
            <CadresTab
              state={editState}
              setState={setEditState}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "titles" && (
            <TitlesTab
              state={editState}
              setState={setEditState}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "specialties" && (
            <SpecialtiesTab
              state={editState}
              setState={setEditState}
              isPlatformOperator={isPlatformOperator}
            />
          )}
          {tab === "publish" && (
            <PublishTab
              state={editState}
              integrityIssues={integrityIssues}
              isPlatformOperator={isPlatformOperator}
              versions={versions.data}
              publishCatalogue={publishCatalogue}
              publishDraft={publishDraft}
              action={action}
            />
          )}
        </>
      )}
    </div>
  );
}

// Type for the edit state
interface EditState {
  countryCode: string;
  version: number;
  notice: string;
  regulators: CatalogueRegulator[];
  departments: CatalogueDepartment[];
  cadres: CatalogueCadre[];
  jobTitles: CatalogueJobTitle[];
  specialties: CatalogueSpecialty[];
}

// Helper to assign temporary IDs for editing
function assignIds<T extends { code: string }>(item: T): T & { id: string } {
  return { ...item, id: `temp-${Math.random().toString(36).substr(2, 9)}` };
}

function OverviewTab({ state, setState, integrityIssues, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  integrityIssues: string[];
  isPlatformOperator: boolean;
}) {
  return (
    <div className="mv-stack">
      <Card title="Catalogue Metadata">
        <div className="mv-grid mv-grid--3" style={{ gap: 16 }}>
          <Field label="Country Code">
            <Input
              value={state.countryCode}
              onChange={(e) => setState({ ...state, countryCode: e.target.value.toUpperCase() })}
              maxLength={2}
              disabled={!isPlatformOperator}
            />
          </Field>
          <Field label="Version">
            <Input
              type="number"
              value={state.version}
              onChange={(e) => setState({ ...state, version: Number(e.target.value) })}
              min={1}
              disabled={!isPlatformOperator}
            />
          </Field>
          <Field label="Status">
            <Input value="Published" readOnly />
          </Field>
        </div>
        <Field label="Notice">
          <Textarea
            value={state.notice}
            onChange={(e) => setState({ ...state, notice: e.target.value })}
            rows={4}
            disabled={!isPlatformOperator}
          />
          <span className="mv-field__hint">Displayed to users when they view the catalogue.</span>
        </Field>
      </Card>

      <Card title="Integrity Check">
        {integrityIssues.length === 0 ? (
          <Notice tone="success">
            <strong>No integrity issues found.</strong> All references are valid.
          </Notice>
        ) : (
          <div className="mv-stack">
            <Notice tone="warning">
              <strong>{integrityIssues.length} integrity issue(s) found.</strong> These must be resolved before publishing.
            </Notice>
            <div style={{ background: "var(--mv-surface-subtle)", padding: 16, borderRadius: 8 }}>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {integrityIssues.map((issue, index) => (
                  <li key={index} style={{ padding: "8px 0" }}>{issue}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>

      <Card title="Catalogue Statistics">
        <div className="mv-grid mv-grid--4" style={{ gap: 16 }}>
          {[
            { label: "Regulators", value: state.regulators.length },
            { label: "Departments", value: state.departments.length },
            { label: "Cadres", value: state.cadres.length },
            { label: "Job Titles", value: state.jobTitles.length },
            { label: "Specialties", value: state.specialties.length },
          ].map((stat, i) => (
            <div key={i}>
              <div className="mv-small mv-muted">{stat.label}</div>
              <div style={{ fontSize: "2rem", fontWeight: "bold" }}>{stat.value}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function RegulatorsTab({ state, setState, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  isPlatformOperator: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Partial<CatalogueRegulator> | null>(null);

  const openEdit = (reg?: CatalogueRegulator) => {
    setEditingId(reg?.id ?? null);
    setEditItem(reg ? { ...reg } : { code: "", name: "", regulatorType: "", country: "UG", verificationMode: "manual" });
  };

  const closeEdit = () => {
    setEditingId(null);
    setEditItem(null);
  };

  const saveEdit = () => {
    if (!editItem || !editItem.code || !editItem.name) return;

    if (editingId) {
      // Update existing
      setState({
        ...state,
        regulators: state.regulators.map(r =>
          r.id === editingId ? { ...r, ...editItem, id: editingId } : r
        )
      });
    } else {
      // Add new
      const newReg = { ...editItem, id: `temp-${Date.now()}` } as CatalogueRegulator;
      setState({
        ...state,
        regulators: [...state.regulators, newReg].sort((a, b) => a.code.localeCompare(b.code))
      });
    }
    closeEdit();
  };

  const deleteItem = (id: string) => {
    if (!isPlatformOperator) return;
    setState({
      ...state,
      regulators: state.regulators.filter(r => r.id !== id)
    });
  };

  const verificationModes = ["manual", "api", "self-declaration"];
  const regulatorTypes = ["council", "board", "association", "ministry", "authority"];

  return (
    <div className="mv-stack">
      <Card
        title="Regulators"
        description="Professional regulatory bodies that oversee credentialing and licensing."
        actions={isPlatformOperator ? [
          <Button size="sm" onClick={() => openEdit()}>+ Add Regulator</Button>
        ] : undefined}
      >
        {state.regulators.length === 0 ? (
          <EmptyState title="No regulators" description="Add your first regulator to get started." />
        ) : (
          <Table head={["Code", "Name", "Type", "Country", "Mode", isPlatformOperator ? "" : null]}>
            {state.regulators.map((reg) => (
              <tr key={reg.id}>
                <td className="mv-id">{reg.code}</td>
                <td><strong>{reg.name}</strong></td>
                <td>{reg.regulatorType}</td>
                <td>{reg.country}</td>
                <td><Badge tone={reg.verificationMode === "manual" ? "neutral" : "info"}>{reg.verificationMode}</Badge></td>
                {isPlatformOperator && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(reg)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteItem(reg.id)}>Delete</Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal isOpen={editItem !== null} onClose={closeEdit} title={editingId ? "Edit Regulator" : "Add Regulator"} size="md">
        <div className="mv-stack">
          <div className="mv-grid mv-grid--2" style={{ gap: 16 }}>
            <Field label="Code (required)">
              <Input
                value={editItem?.code ?? ""}
                onChange={(e) => setEditItem({ ...editItem, code: e.target.value.toUpperCase() })}
                maxLength={10}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Name (required)">
              <Input
                value={editItem?.name ?? ""}
                onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
              />
            </Field>
            <Field label="Regulator Type">
              <OptionSelect
                value={editItem?.regulatorType ?? ""}
                onChange={(e) => setEditItem({ ...editItem, regulatorType: e.target.value })}
                options={regulatorTypes.map(t => ({ value: t, label: t }))}
              />
            </Field>
            <Field label="Country">
              <Input
                value={editItem?.country ?? "UG"}
                onChange={(e) => setEditItem({ ...editItem, country: e.target.value.toUpperCase() })}
                maxLength={2}
              />
            </Field>
            <Field label="Verification Mode">
              <OptionSelect
                value={editItem?.verificationMode ?? "manual"}
                onChange={(e) => setEditItem({ ...editItem, verificationMode: e.target.value })}
                options={verificationModes.map(m => ({ value: m, label: m }))}
              />
            </Field>
            <Field label="Website">
              <Input
                value={editItem?.website ?? ""}
                onChange={(e) => setEditItem({ ...editItem, website: e.target.value })}
                type="url"
              />
            </Field>
          </div>
          <Field label="Notes">
            <Textarea
              value={editItem?.notes ?? ""}
              onChange={(e) => setEditItem({ ...editItem, notes: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
            <Button variant="secondary" onClick={closeEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={!editItem?.code || !editItem?.name}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DepartmentsTab({ state, setState, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  isPlatformOperator: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Partial<CatalogueDepartment> | null>(null);

  const openEdit = (dept?: CatalogueDepartment) => {
    setEditingId(dept?.id ?? null);
    setEditItem(dept ? { ...dept } : { code: "", name: "", sortOrder: state.departments.length });
  };

  const closeEdit = () => {
    setEditingId(null);
    setEditItem(null);
  };

  const saveEdit = () => {
    if (!editItem || !editItem.code || !editItem.name) return;

    if (editingId) {
      setState({
        ...state,
        departments: state.departments.map(d =>
          d.id === editingId ? { ...d, ...editItem, id: editingId } : d
        )
      });
    } else {
      const newDept = { ...editItem, id: `temp-${Date.now()}` } as CatalogueDepartment;
      setState({
        ...state,
        departments: [...state.departments, newDept].sort((a, b) => a.sortOrder - b.sortOrder)
      });
    }
    closeEdit();
  };

  const deleteItem = (id: string) => {
    if (!isPlatformOperator) return;
    setState({
      ...state,
      departments: state.departments.filter(d => d.id !== id)
    });
  };

  return (
    <div className="mv-stack">
      <Card
        title="Departments"
        description="Clinical and administrative departments."
        actions={isPlatformOperator ? [
          <Button size="sm" onClick={() => openEdit()}>+ Add Department</Button>
        ] : undefined}
      >
        {state.departments.length === 0 ? (
          <EmptyState title="No departments" description="Add your first department to get started." />
        ) : (
          <Table head={["Code", "Name", "Sort", "Description", isPlatformOperator ? "" : null]}>
            {state.departments.map((dept) => (
              <tr key={dept.id}>
                <td className="mv-id">{dept.code}</td>
                <td><strong>{dept.name}</strong></td>
                <td>{dept.sortOrder}</td>
                <td className="mv-small">{dept.description || "-"}</td>
                {isPlatformOperator && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(dept)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteItem(dept.id)}>Delete</Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal isOpen={editItem !== null} onClose={closeEdit} title={editingId ? "Edit Department" : "Add Department"} size="md">
        <div className="mv-stack">
          <div className="mv-grid mv-grid--2" style={{ gap: 16 }}>
            <Field label="Code (required)">
              <Input
                value={editItem?.code ?? ""}
                onChange={(e) => setEditItem({ ...editItem, code: e.target.value.toUpperCase() })}
                maxLength={10}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Name (required)">
              <Input
                value={editItem?.name ?? ""}
                onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
              />
            </Field>
            <Field label="Sort Order">
              <Input
                type="number"
                value={editItem?.sortOrder ?? 0}
                onChange={(e) => setEditItem({ ...editItem, sortOrder: Number(e.target.value) })}
                min={0}
              />
            </Field>
          </div>
          <Field label="Description">
            <Textarea
              value={editItem?.description ?? ""}
              onChange={(e) => setEditItem({ ...editItem, description: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
            <Button variant="secondary" onClick={closeEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={!editItem?.code || !editItem?.name}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function CadresTab({ state, setState, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  isPlatformOperator: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Partial<CatalogueCadre> | null>(null);

  const openEdit = (cadre?: CatalogueCadre) => {
    setEditingId(cadre?.id ?? null);
    setEditItem(cadre ? { ...cadre } : {
      code: "",
      name: "",
      category: "",
      regulatorCodes: [],
      requiresRegistration: true
    });
  };

  const closeEdit = () => {
    setEditingId(null);
    setEditItem(null);
  };

  const saveEdit = () => {
    if (!editItem || !editItem.code || !editItem.name) return;

    if (editingId) {
      setState({
        ...state,
        cadres: state.cadres.map(c =>
          c.id === editingId ? { ...c, ...editItem, id: editingId } : c
        )
      });
    } else {
      const newCadre = { ...editItem, id: `temp-${Date.now()}` } as CatalogueCadre;
      setState({
        ...state,
        cadres: [...state.cadres, newCadre].sort((a, b) => a.name.localeCompare(b.name))
      });
    }
    closeEdit();
  };

  const deleteItem = (id: string) => {
    if (!isPlatformOperator) return;
    setState({
      ...state,
      cadres: state.cadres.filter(c => c.id !== id)
    });
  };

  // Get available regulators for the multi-select
  const regulators = state.regulators.map(r => ({ value: r.code, label: `${r.code} - ${r.name}` }));

  return (
    <div className="mv-stack">
      <Card
        title="Professional Cadres"
        description="Categories of healthcare professionals."
        actions={isPlatformOperator ? [
          <Button size="sm" onClick={() => openEdit()}>+ Add Cadre</Button>
        ] : undefined}
      >
        {state.cadres.length === 0 ? (
          <EmptyState title="No cadres" description="Add your first cadre to get started." />
        ) : (
          <Table head={["Code", "Name", "Category", "Reg. Required", "Regulators", isPlatformOperator ? "" : null]}>
            {state.cadres.map((cadre) => (
              <tr key={cadre.id}>
                <td className="mv-id">{cadre.code}</td>
                <td><strong>{cadre.name}</strong></td>
                <td>{cadre.category}</td>
                <td>
                  <Badge tone={cadre.requiresRegistration ? "warning" : "success"}>
                    {cadre.requiresRegistration ? "Yes" : "No"}
                  </Badge>
                </td>
                <td className="mv-small">{cadre.regulatorCodes.join(", ") || "-"}</td>
                {isPlatformOperator && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(cadre)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteItem(cadre.id)}>Delete</Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal isOpen={editItem !== null} onClose={closeEdit} title={editingId ? "Edit Cadre" : "Add Cadre"} size="lg">
        <div className="mv-stack">
          <div className="mv-grid mv-grid--2" style={{ gap: 16 }}>
            <Field label="Code (required)">
              <Input
                value={editItem?.code ?? ""}
                onChange={(e) => setEditItem({ ...editItem, code: e.target.value.toUpperCase() })}
                maxLength={10}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Name (required)">
              <Input
                value={editItem?.name ?? ""}
                onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <Input
                value={editItem?.category ?? ""}
                onChange={(e) => setEditItem({ ...editItem, category: e.target.value })}
              />
            </Field>
            <Field label="Requires Registration">
              <OptionSelect
                value={editItem?.requiresRegistration ? "true" : "false"}
                onChange={(e) => setEditItem({ ...editItem, requiresRegistration: e.target.value === "true" })}
                options={[
                  { value: "true", label: "Yes - Registration Required" },
                  { value: "false", label: "No - No Registration" }
                ]}
              />
            </Field>
          </div>
          <Field label="Regulator Codes" hint="Select the regulatory bodies that govern this cadre">
            <OptionSelect
              multiple
              value={editItem?.regulatorCodes ?? []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, o => o.value);
                setEditItem({ ...editItem, regulatorCodes: selected });
              }}
              options={regulators}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={editItem?.description ?? ""}
              onChange={(e) => setEditItem({ ...editItem, description: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
            <Button variant="secondary" onClick={closeEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={!editItem?.code || !editItem?.name}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TitlesTab({ state, setState, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  isPlatformOperator: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Partial<CatalogueJobTitle> | null>(null);

  const openEdit = (title?: CatalogueJobTitle) => {
    setEditingId(title?.id ?? null);
    setEditItem(title ? { ...title } : {
      code: "",
      name: "",
      cadreCode: "",
      seniority: "",
      departmentCodes: [],
      requiresCredential: false,
      privilegeCodes: [],
      suggestedSystemRoles: []
    });
  };

  const closeEdit = () => {
    setEditingId(null);
    setEditItem(null);
  };

  const saveEdit = () => {
    if (!editItem || !editItem.code || !editItem.name || !editItem.cadreCode) return;

    if (editingId) {
      setState({
        ...state,
        jobTitles: state.jobTitles.map(t =>
          t.id === editingId ? { ...t, ...editItem, id: editingId } : t
        )
      });
    } else {
      const newTitle = { ...editItem, id: `temp-${Date.now()}` } as CatalogueJobTitle;
      setState({
        ...state,
        jobTitles: [...state.jobTitles, newTitle].sort((a, b) => a.name.localeCompare(b.name))
      });
    }
    closeEdit();
  };

  const deleteItem = (id: string) => {
    if (!isPlatformOperator) return;
    setState({
      ...state,
      jobTitles: state.jobTitles.filter(t => t.id !== id)
    });
  };

  // Get available cadres, departments for selects
  const cadreOptions = state.cadres.map(c => ({ value: c.code, label: `${c.code} - ${c.name}` }));
  const deptOptions = state.departments.map(d => ({ value: d.code, label: `${d.code} - ${d.name}` }));
  const seniorityOptions = ["consultant", "senior", "mid-level", "junior", "intern", "student", "assistant", "associate", "principal", "head"];

  return (
    <div className="mv-stack">
      <Card
        title="Job Titles"
        description="Specific job titles within each professional cadre."
        actions={isPlatformOperator ? [
          <Button size="sm" onClick={() => openEdit()}>+ Add Job Title</Button>
        ] : undefined}
      >
        {state.jobTitles.length === 0 ? (
          <EmptyState title="No job titles" description="Add your first job title to get started." />
        ) : (
          <Table head={["Code", "Name", "Cadre", "Seniority", "Departments", "Credential", isPlatformOperator ? "" : null]}>
            {state.jobTitles.map((title) => (
              <tr key={title.id}>
                <td className="mv-id">{title.code}</td>
                <td><strong>{title.name}</strong></td>
                <td>{state.cadres.find(c => c.code === title.cadreCode)?.name ?? title.cadreCode}</td>
                <td>{title.seniority}</td>
                <td className="mv-small">{title.departmentCodes.join(", ")}</td>
                <td>
                  <Badge tone={title.requiresCredential ? "warning" : "success"}>
                    {title.requiresCredential ? "Required" : "Not Required"}
                  </Badge>
                </td>
                {isPlatformOperator && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(title)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteItem(title.id)}>Delete</Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal isOpen={editItem !== null} onClose={closeEdit} title={editingId ? "Edit Job Title" : "Add Job Title"} size="lg">
        <div className="mv-stack">
          <div className="mv-grid mv-grid--2" style={{ gap: 16 }}>
            <Field label="Code (required)">
              <Input
                value={editItem?.code ?? ""}
                onChange={(e) => setEditItem({ ...editItem, code: e.target.value.toUpperCase() })}
                maxLength={20}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Name (required)">
              <Input
                value={editItem?.name ?? ""}
                onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
              />
            </Field>
            <Field label="Cadre (required)">
              <OptionSelect
                value={editItem?.cadreCode ?? ""}
                onChange={(e) => setEditItem({ ...editItem, cadreCode: e.target.value })}
                options={cadreOptions}
              />
            </Field>
            <Field label="Seniority">
              <OptionSelect
                value={editItem?.seniority ?? ""}
                onChange={(e) => setEditItem({ ...editItem, seniority: e.target.value })}
                options={seniorityOptions.map(s => ({ value: s, label: s }))}
              />
            </Field>
            <Field label="Requires Credential">
              <OptionSelect
                value={editItem?.requiresCredential ? "true" : "false"}
                onChange={(e) => setEditItem({ ...editItem, requiresCredential: e.target.value === "true" })}
                options={[
                  { value: "true", label: "Yes" },
                  { value: "false", label: "No" }
                ]}
              />
            </Field>
          </div>
          <Field label="Departments" hint="Select the departments this title can belong to">
            <OptionSelect
              multiple
              value={editItem?.departmentCodes ?? []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, o => o.value);
                setEditItem({ ...editItem, departmentCodes: selected });
              }}
              options={deptOptions}
            />
          </Field>
          <Field label="Privilege Codes" hint="Comma-separated list of privilege codes">
            <Input
              value={editItem?.privilegeCodes?.join(", ") ?? ""}
              onChange={(e) => setEditItem({ ...editItem, privilegeCodes: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="Suggested System Roles" hint="Comma-separated list of role names">
            <Input
              value={editItem?.suggestedSystemRoles?.join(", ") ?? ""}
              onChange={(e) => setEditItem({ ...editItem, suggestedSystemRoles: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={editItem?.description ?? ""}
              onChange={(e) => setEditItem({ ...editItem, description: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
            <Button variant="secondary" onClick={closeEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={!editItem?.code || !editItem?.name || !editItem?.cadreCode}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function SpecialtiesTab({ state, setState, isPlatformOperator }: {
  state: EditState;
  setState: (state: EditState) => void;
  isPlatformOperator: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editItem, setEditItem] = useState<Partial<CatalogueSpecialty> | null>(null);

  const openEdit = (specialty?: CatalogueSpecialty) => {
    setEditingId(specialty?.id ?? null);
    setEditItem(specialty ? { ...specialty } : {
      code: "",
      name: "",
      cadreCodes: [],
      departmentCodes: []
    });
  };

  const closeEdit = () => {
    setEditingId(null);
    setEditItem(null);
  };

  const saveEdit = () => {
    if (!editItem || !editItem.code || !editItem.name) return;

    if (editingId) {
      setState({
        ...state,
        specialties: state.specialties.map(s =>
          s.id === editingId ? { ...s, ...editItem, id: editingId } : s
        )
      });
    } else {
      const newSpecialty = { ...editItem, id: `temp-${Date.now()}` } as CatalogueSpecialty;
      setState({
        ...state,
        specialties: [...state.specialties, newSpecialty].sort((a, b) => a.name.localeCompare(b.name))
      });
    }
    closeEdit();
  };

  const deleteItem = (id: string) => {
    if (!isPlatformOperator) return;
    setState({
      ...state,
      specialties: state.specialties.filter(s => s.id !== id)
    });
  };

  // Get available cadres, departments for selects
  const cadreOptions = state.cadres.map(c => ({ value: c.code, label: `${c.code} - ${c.name}` }));
  const deptOptions = state.departments.map(d => ({ value: d.code, label: `${d.code} - ${d.name}` }));

  return (
    <div className="mv-stack">
      <Card
        title="Specialties"
        description="Clinical and professional specialties."
        actions={isPlatformOperator ? [
          <Button size="sm" onClick={() => openEdit()}>+ Add Specialty</Button>
        ] : undefined}
      >
        {state.specialties.length === 0 ? (
          <EmptyState title="No specialties" description="Add your first specialty to get started." />
        ) : (
          <Table head={["Code", "Name", "Cadres", "Departments", isPlatformOperator ? "" : null]}>
            {state.specialties.map((specialty) => (
              <tr key={specialty.id}>
                <td className="mv-id">{specialty.code}</td>
                <td><strong>{specialty.name}</strong></td>
                <td className="mv-small">{specialty.cadreCodes.join(", ")}</td>
                <td className="mv-small">{specialty.departmentCodes.join(", ")}</td>
                {isPlatformOperator && (
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(specialty)}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => deleteItem(specialty.id)}>Delete</Button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Modal isOpen={editItem !== null} onClose={closeEdit} title={editingId ? "Edit Specialty" : "Add Specialty"} size="lg">
        <div className="mv-stack">
          <div className="mv-grid mv-grid--2" style={{ gap: 16 }}>
            <Field label="Code (required)">
              <Input
                value={editItem?.code ?? ""}
                onChange={(e) => setEditItem({ ...editItem, code: e.target.value.toUpperCase() })}
                maxLength={20}
                disabled={!!editingId}
              />
            </Field>
            <Field label="Name (required)">
              <Input
                value={editItem?.name ?? ""}
                onChange={(e) => setEditItem({ ...editItem, name: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Cadre Codes" hint="Select the cadres that can have this specialty">
            <OptionSelect
              multiple
              value={editItem?.cadreCodes ?? []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, o => o.value);
                setEditItem({ ...editItem, cadreCodes: selected });
              }}
              options={cadreOptions}
            />
          </Field>
          <Field label="Department Codes" hint="Select the departments this specialty belongs to">
            <OptionSelect
              multiple
              value={editItem?.departmentCodes ?? []}
              onChange={(e) => {
                const selected = Array.from(e.target.selectedOptions, o => o.value);
                setEditItem({ ...editItem, departmentCodes: selected });
              }}
              options={deptOptions}
            />
          </Field>
          <Field label="Description">
            <Textarea
              value={editItem?.description ?? ""}
              onChange={(e) => setEditItem({ ...editItem, description: e.target.value })}
              rows={3}
            />
          </Field>
          <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
            <Button variant="secondary" onClick={closeEdit}>Cancel</Button>
            <Button onClick={saveEdit} disabled={!editItem?.code || !editItem?.name}>Save</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PublishTab({ integrityIssues, isPlatformOperator, versions, publishCatalogue, publishDraft, action }: any) {
  return (
    <div className="mv-stack">
      <Card title="Publish Catalogue" description="Review and publish the catalogue for use across all facilities.">
        <div className="mv-stack">
          <h4>Before Publishing</h4>
          <ul className="mv-small" style={{ paddingLeft: 20 }}>
            <li>Review all entries for accuracy and completeness</li>
            <li>Verify that all references are valid (no integrity issues)</li>
            <li>Ensure the version number is incremented appropriately</li>
            <li>Remember: Publishing will retire the previous version</li>
          </ul>

          {integrityIssues.length > 0 && (
            <Notice tone="warning" title="Cannot Publish">
              <p><strong>There are {integrityIssues.length} integrity issue(s) that must be resolved before publishing.</strong></p>
            </Notice>
          )}

          {isPlatformOperator && (
            <div className="mv-stack" style={{ marginTop: 24 }}>
              <h4>Previous Versions</h4>
              {versions?.versions?.length === 0 ? (
                <EmptyState title="No previous versions" description="This will be the first published version." />
              ) : (
                <Table head={["Version", "Status", "Published", "Action"]}>
                  {versions?.versions.map((version: any) => (
                    <tr key={version.id}>
                      <td>v{version.version}</td>
                      <td><Badge tone={version.status === "published" ? "success" : "neutral"}>{version.status}</Badge></td>
                      <td className="mv-small">{version.publishedAt ? new Date(version.publishedAt).toLocaleString() : "-"}</td>
                      <td>
                        {version.status === "draft" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => publishDraft(version.id)}
                            disabled={action.busy !== null || integrityIssues.length > 0}
                          >
                            {action.busy === `publish-draft-${version.id}` ? "Publishing..." : "Publish"}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </div>
          )}

          {isPlatformOperator && (
            <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
              <Button
                variant="secondary"
                onClick={() => publishCatalogue(true)}
                disabled={action.busy !== null}
              >
                {action.busy === "publish-catalogue" ? "Saving..." : "Save as Draft"}
              </Button>
              <Button
                onClick={() => publishCatalogue(false)}
                disabled={action.busy !== null || integrityIssues.length > 0}
              >
                {action.busy === "publish-catalogue" ? "Publishing..." : "Publish Catalogue"}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {!isPlatformOperator && (
        <Card title="Facility-Specific Customizations" description="As a facility administrator, you can add local job titles and customize the catalogue.">
          <Notice tone="info">
            <p><strong>Platform-level catalogue editing is restricted to platform operators.</strong></p>
            <p>However, as a facility administrator, you can:</p>
            <ul style={{ paddingLeft: 20, marginTop: 8 }}>
              <li>Request custom titles during onboarding</li>
              <li>Approve or reject custom title requests</li>
              <li>Define facility-specific credential policies</li>
              <li>Manage your facility's department structure</li>
            </ul>
            <p style={{ marginTop: 8 }}>Navigate to the Workforce or Onboarding pages to manage these facility-specific settings.</p>
          </Notice>
        </Card>
      )}
    </div>
  );
}

interface SelectOption { value: string; label: string }

function OptionSelect({ options, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { options: SelectOption[] }) {
  return (
    <Select {...props}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </Select>
  );
}

function Modal({ isOpen, onClose, title, size = "md", children }: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: "md" | "lg";
  children: ReactNode;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0, 0, 0, 0.45)" }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%", maxWidth: size === "lg" ? 760 : 560, maxHeight: "90vh", overflowY: "auto", padding: 24,
          background: "var(--mv-surface)", border: "1px solid var(--mv-border)", borderRadius: 8,
        }}
      >
        <div className="mv-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 className="mv-card__title">{title}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close">Close</Button>
        </div>
        {children}
      </div>
    </div>
  );
}
