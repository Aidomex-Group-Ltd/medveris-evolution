import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Notice, PageHeader, SearchSelect, Select, Textarea } from "@medveris/ui";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useQuery } from "../lib/useQuery";
import { useAction } from "../lib/useAction";

// Types for the onboarding workflow
interface CatalogueDepartment { code: string; name: string; description?: string; sortOrder: number }
interface CatalogueCadre { code: string; name: string; category: string; regulatorCodes: string[]; requiresRegistration: boolean }
interface CatalogueJobTitle {
  code: string; name: string; cadreCode: string; seniority: string;
  departmentCodes: string[]; requiresCredential: boolean;
  privilegeCodes: string[]; suggestedSystemRoles: string[];
}
interface CatalogueSpecialty { code: string; name: string; cadreCodes: string[]; departmentCodes: string[] }
interface CatalogueRegulator { code: string; name: string; regulatorType: string }

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

interface Facility { id: string; name: string; slug: string; facilityType: string; city: string; country: string }
interface Department { id: string; code: string; name: string; catalogueCode: string | null }

// Onboarding form state
interface OnboardingFormState {
  accountType: string;
  facilityId?: string;
  givenName: string;
  familyName: string;
  email?: string;
  phone?: string;
  staffId?: string;
  engagementType: string;
  startDate: string;
  cadreCode?: string;
  titleCode?: string;
  customTitle?: string;
  customTitleExplanation?: string;
  departmentCodes: string[];
  specialtyCodes: string[];
  regulatorCodes: string[];
  credentialRequired: boolean;
  requestedSystemRoles: string[];
  // For save-and-resume
  savedStateId?: string;
}

export function OnboardingWorkflowPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const action = useAction();
  
  // Check if user is already authenticated and redirect if needed
  const isAuthenticated = me !== null;
  const isPatient = me?.patientId !== undefined;
  const isStaff = me?.activeTenant !== undefined;
  
  // If authenticated staff tries to access patient onboarding, redirect
  if (isAuthenticated && isStaff && params.get("type") === "patient") {
    navigate("/onboarding?type=staff");
  }
  
  // If authenticated patient tries to access staff onboarding, redirect
  if (isAuthenticated && isPatient && params.get("type") === "staff") {
    navigate("/onboarding?type=patient");
  }

  const onboardingType = params.get("type") === "patient" ? "patient" : "staff";
  
  // Load catalogue
  const catalogue = useQuery<{
    source: string;
    countryCode: string;
    version: number;
    notice: string;
    catalogue: OnboardingCatalogue;
    accountTypes: { code: string; label: string; description: string }[];
    titles: CatalogueJobTitle[];
    cadres: CatalogueCadre[];
    departments: CatalogueDepartment[];
    specialties: CatalogueSpecialty[];
  }>("/onboarding/catalogue");

  // Load facilities
  const facilities = useQuery<{ facilities: Facility[]; notice: string }>("/onboarding/facilities");
  
  // Load departments for the current tenant
  const departments = useQuery<{ departments: Department[] }>("/organization/departments");
  
  // Form state
  const [form, setForm] = useState<OnboardingFormState>(() => ({
    accountType: onboardingType === "patient" ? "patient" : "",
    givenName: "",
    familyName: "",
    engagementType: "employee",
    startDate: new Date().toISOString().slice(0, 10),
    departmentCodes: [],
    specialtyCodes: [],
    regulatorCodes: [],
    requestedSystemRoles: [],
    credentialRequired: false,
  }));

  // Filtered data based on selections
  const filteredCadres = useMemo(() => {
    if (!form.accountType || form.accountType === "patient") return [];
    const accountTypeEntry = catalogue.data?.accountTypes.find(a => a.code === form.accountType);
    if (!accountTypeEntry) return catalogue.data?.cadres ?? [];
    
    // Map account type to relevant cadres
    const accountTypeToCadres: Record<string, string[]> = {
      clinician: ["medical", "clinical", "dental", "eye-ent", "emergency", "anaesthesia"],
      nurse: ["nursing", "midwifery"],
      allied_health: ["pharmacy", "laboratory", "radiology", "rehabilitation", "nutrition", "mental-health", "public-health", "health-information"],
      support: ["support", "technical", "mortuary", "security"],
      administrative: ["administrative", "administration", "finance", "data", "education", "research", "governance", "quality"],
      trainee: ["trainee"],
      facility_admin: ["administration"],
    };
    
    const categories = accountTypeToCadres[form.accountType] ?? [];
    return (catalogue.data?.cadres ?? []).filter(c => categories.includes(c.category));
  }, [form.accountType, catalogue.data]);

  const filteredTitles = useMemo(() => {
    if (!form.cadreCode && !form.accountType) return catalogue.data?.titles ?? [];
    
    let titles = catalogue.data?.titles ?? [];
    
    // Filter by cadre
    if (form.cadreCode) {
      titles = titles.filter(t => t.cadreCode === form.cadreCode);
    }
    
    // Filter by department if selected
    if (form.departmentCodes.length > 0) {
      const deptCodes = form.departmentCodes;
      titles = titles.filter(t => 
        t.departmentCodes.some(dc => deptCodes.includes(dc))
      );
    }
    
    return titles;
  }, [form.cadreCode, form.departmentCodes, catalogue.data]);

  const filteredDepartments = useMemo(() => {
    if (!form.cadreCode) return catalogue.data?.departments ?? [];
    
    const cadre = catalogue.data?.cadres.find(c => c.code === form.cadreCode);
    if (!cadre) return catalogue.data?.departments ?? [];
    
    // Get titles for this cadre and collect their department codes
    const titreDepts = new Set<string>();
    (catalogue.data?.titles ?? [])
      .filter(t => t.cadreCode === form.cadreCode)
      .forEach(t => t.departmentCodes.forEach(d => titreDepts.add(d)));
    
    return (catalogue.data?.departments ?? [])
      .filter(d => titreDepts.has(d.code))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [form.cadreCode, catalogue.data]);

  const filteredSpecialties = useMemo(() => {
    const cadreCode = form.cadreCode;
    if (!cadreCode) return catalogue.data?.specialties ?? [];
    
    return (catalogue.data?.specialties ?? [])
      .filter(s => s.cadreCodes.includes(cadreCode));
  }, [form.cadreCode, catalogue.data]);

  const selectedTitle = useMemo(() => {
    if (!form.titleCode) return null;
    return (catalogue.data?.titles ?? []).find(t => t.code === form.titleCode) ?? null;
  }, [form.titleCode, catalogue.data]);

  const selectedCadre = useMemo(() => {
    if (!form.cadreCode) return null;
    return (catalogue.data?.cadres ?? []).find(c => c.code === form.cadreCode) ?? null;
  }, [form.cadreCode, catalogue.data]);

  // Handle account type selection
  const handleAccountTypeChange = useCallback((value: string) => {
    setForm(prev => ({
      ...prev,
      accountType: value,
      cadreCode: undefined,
      titleCode: undefined,
      departmentCodes: [],
      specialtyCodes: [],
    }));
  }, []);

  // Handle cadre selection
  const handleCadreChange = useCallback((value: string) => {
    const cadre = (catalogue.data?.cadres ?? []).find(c => c.code === value);
    setForm(prev => ({
      ...prev,
      cadreCode: value,
      titleCode: undefined,
      departmentCodes: [],
      specialtyCodes: [],
      regulatorCodes: cadre?.regulatorCodes ?? [],
      credentialRequired: cadre?.requiresRegistration ?? false,
      requestedSystemRoles: [],
    }));
  }, [catalogue.data]);

  // Handle title selection
  const handleTitleChange = useCallback((value: string) => {
    const title = (catalogue.data?.titles ?? []).find(t => t.code === value);
    if (!title) {
      setForm(prev => ({ ...prev, titleCode: undefined }));
      return;
    }
    
    const cadre = (catalogue.data?.cadres ?? []).find(c => c.code === title.cadreCode);
    
    setForm(prev => ({
      ...prev,
      titleCode: value,
      cadreCode: title.cadreCode,
      departmentCodes: title.departmentCodes,
      credentialRequired: title.requiresCredential,
      requestedSystemRoles: title.suggestedSystemRoles,
      regulatorCodes: cadre?.regulatorCodes ?? [],
    }));
  }, [catalogue.data]);

  // Handle department selection
  const handleDepartmentChange = useCallback((selectedDepts: string[]) => {
    setForm(prev => ({ ...prev, departmentCodes: selectedDepts }));
  }, []);

  // Handle specialty selection
  const handleSpecialtyChange = useCallback((selectedSpecialties: string[]) => {
    setForm(prev => ({ ...prev, specialtyCodes: selectedSpecialties }));
  }, []);

  // Handle form field changes
  const handleFieldChange = useCallback((field: keyof OnboardingFormState, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
  }, []);

  // Check if credential fields should be shown
  const showCredentialFields = useMemo(() => {
    if (onboardingType === "patient") return false;
    if (form.credentialRequired) return true;
    if (selectedCadre?.requiresRegistration) return true;
    return false;
  }, [onboardingType, form.credentialRequired, selectedCadre]);

  // Check form validity
  const isFormValid = useMemo(() => {
    if (onboardingType === "patient") {
      return form.givenName.trim().length > 0 && 
             form.familyName.trim().length > 0;
    }
    
    // Staff onboarding
    if (!form.accountType || form.accountType === "patient") return false;
    if (!form.givenName.trim() || !form.familyName.trim()) return false;
    if (!form.facilityId) return false;
    if (!form.engagementType) return false;
    if (!form.startDate) return false;
    
    // For staff, we need either a catalogue title or a custom title
    if (!form.titleCode && !form.customTitle) return false;
    
    return true;
  }, [onboardingType, form]);

  // Submit handlers
  async function submitPatientOnboarding(event: FormEvent) {
    event.preventDefault();
    
    await action.run("patient-onboarding", async () => {
      // Patient onboarding is handled through the existing registration flow
      navigate("/register?type=patient");
      return "Redirecting to patient registration...";
    });
  }

  async function submitStaffOnboarding(event: FormEvent) {
    event.preventDefault();
    
    if (!form.facilityId) {
      action.setError("Please select a facility");
      return;
    }
    
    // Find the actual department IDs from the catalogue codes
    const deptIds: string[] = [];
    if (form.departmentCodes.length > 0) {
      for (const deptCode of form.departmentCodes) {
        const dept = departments.data?.departments.find(d => d.catalogueCode === deptCode);
        if (dept) deptIds.push(dept.id);
      }
    }
    
    // Handle custom title request
    let customTitleRequestId: string | undefined;
    if (form.customTitle && form.customTitle.trim().length > 0) {
      const customRequest = await api<{ request: { id: string; status: string } }>("/onboarding/custom-titles", {
        method: "POST",
        body: {
          proposedName: form.customTitle,
          cadreCode: form.cadreCode,
          departmentCodes: form.departmentCodes,
          specialtyCodes: form.specialtyCodes,
          explanation: form.customTitleExplanation ?? "Requested via onboarding workflow",
        },
      });
      customTitleRequestId = customRequest.request.id;
    }
    
    // Submit onboarding
    const result = await api<{ onboarding: { staffRef: string; caseId: string } }>("/workforce/onboarding", {
      method: "POST",
      body: {
        givenName: form.givenName,
        familyName: form.familyName,
        email: form.email || undefined,
        phone: form.phone || undefined,
        engagementType: form.engagementType as any,
        startDate: form.startDate,
        primaryDepartmentId: deptIds[0] ?? null,
        additionalDepartmentIds: deptIds.slice(1),
        catalogueTitleCode: form.titleCode || undefined,
        catalogueCadreCode: selectedCadre?.code,
        specialtyCodes: form.specialtyCodes,
        customTitleRequestId,
        staffRef: form.staffId,
      },
    });
    
    setForm(prev => ({ ...prev, savedStateId: result.onboarding.caseId }));
    action.setMessage(`Onboarding started! Your staff reference is: ${result.onboarding.staffRef}`);
    
    // Navigate to onboarding checklist
    setTimeout(() => navigate(`/onboarding?type=staff&caseId=${result.onboarding.caseId}`), 2000);
  }

  async function saveDraft() {
    // Save the current form state for resume later
    // In a real implementation, this would save to localStorage or the server
    localStorage.setItem("onboarding-draft", JSON.stringify(form));
    action.setMessage("Your onboarding progress has been saved. You can resume later.");
  }

  // Load saved draft on component mount
  useEffect(() => {
    if (onboardingType === "staff") {
      const saved = localStorage.getItem("onboarding-draft");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as OnboardingFormState;
          setForm(prev => ({ ...prev, ...parsed }));
        } catch {
          // Ignore invalid saved state
        }
      }
    }
  }, [onboardingType]);

  // Clear draft when form is submitted
  useEffect(() => {
    if (form.savedStateId) {
      localStorage.removeItem("onboarding-draft");
    }
  }, [form.savedStateId]);

  if (catalogue.loading || facilities.loading) {
    return <LoadingState />;
  }

  if (catalogue.error) {
    return <ErrorState message={catalogue.error} onRetry={catalogue.reload} />;
  }

  return (
    <div className="mv-stack">
      <PageHeader
        eyebrow="Onboarding"
        title={onboardingType === "patient" ? "Patient Onboarding" : "Staff Onboarding"}
        description={onboardingType === "patient" 
          ? "Create your patient identity and access your health records. A patient ID locates your identity but never authorizes record access by itself."
          : "Join a healthcare facility and begin your professional journey. Selecting a title never grants clinical privileges without facility approval."
        }
      />

      {action.error ? <ErrorState message={action.error} /> : null}
      {action.message ? <Notice tone="success">{action.message}</Notice> : null}

      {/* Progress indicator */}
      <Card>
        <div className="mv-row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div>
            <strong>Step 1 of {onboardingType === "patient" ? 3 : 5}</strong>
            <span className="mv-muted" style={{ marginLeft: 8 }}>
              {onboardingType === "patient" ? "Create Identity" : "Professional Details"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={saveDraft} disabled={!form.givenName || !form.familyName}>
            Save Draft
          </Button>
        </div>
      </Card>

      <form className="mv-stack" onSubmit={onboardingType === "patient" ? submitPatientOnboarding : submitStaffOnboarding}>
        {onboardingType === "patient" ? (
          /* Patient Onboarding */
          <PatientOnboardingSection form={form} onChange={handleFieldChange} />
        ) : (
          /* Staff Onboarding */
          <>
            <Card title="Account Type" description="Select the type of account you're creating. This helps us guide you through the appropriate onboarding path.">
              <Field label="I am a..." htmlFor="account-type">
                <Select
                  id="account-type"
                  value={form.accountType}
                  onChange={(e) => handleAccountTypeChange(e.target.value)}
                  required
                >
                  <option value="">Select your role category...</option>
                  {catalogue.data?.accountTypes.map((type) => (
                    <option key={type.code} value={type.code}>
                      {type.label} - {type.description}
                    </option>
                  ))}
                </Select>
              </Field>
            </Card>

            {form.accountType && (
              <>
                <Card title="Facility" description="Select the healthcare facility you're joining. You can be affiliated with multiple facilities.">
                  <Field label="Healthcare Facility" htmlFor="facility">
                    <Select
                      id="facility"
                      value={form.facilityId ?? ""}
                      onChange={(e) => handleFieldChange("facilityId", e.target.value)}
                      required
                    >
                      <option value="">Select a facility...</option>
                      {facilities.data?.facilities.map((fac) => (
                        <option key={fac.id} value={fac.id}>
                          {fac.name} ({fac.city}) - {fac.facilityType}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </Card>

                <Card title="Professional Identity" description="Your professional details and credentials.">
                  <div className="mv-form-grid">
                    <Field label="Given Name" htmlFor="given-name">
                      <Input
                        id="given-name"
                        value={form.givenName}
                        onChange={(e) => handleFieldChange("givenName", e.target.value)}
                        required
                        minLength={1}
                        maxLength={120}
                      />
                    </Field>
                    <Field label="Family Name" htmlFor="family-name">
                      <Input
                        id="family-name"
                        value={form.familyName}
                        onChange={(e) => handleFieldChange("familyName", e.target.value)}
                        required
                        minLength={1}
                        maxLength={120}
                      />
                    </Field>
                  </div>
                  <div className="mv-form-grid">
                    <Field label="Email" htmlFor="email">
                      <Input
                        id="email"
                        type="email"
                        value={form.email ?? ""}
                        onChange={(e) => handleFieldChange("email", e.target.value)}
                      />
                    </Field>
                    <Field label="Phone" htmlFor="phone">
                      <Input
                        id="phone"
                        type="tel"
                        value={form.phone ?? ""}
                        onChange={(e) => handleFieldChange("phone", e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="Staff ID / Employee Number" htmlFor="staff-id">
                    <Input
                      id="staff-id"
                      value={form.staffId ?? ""}
                      onChange={(e) => handleFieldChange("staffId", e.target.value)}
                      placeholder="Your facility staff identifier"
                    />
                  </Field>
                  <div className="mv-form-grid">
                    <Field label="Engagement Type">
                      <Select
                        value={form.engagementType}
                        onChange={(e) => handleFieldChange("engagementType", e.target.value)}
                        required
                      >
                        <option value="employee">Employee</option>
                        <option value="contractor">Contractor</option>
                        <option value="student">Student</option>
                        <option value="intern">Intern</option>
                        <option value="trainee">Trainee</option>
                        <option value="volunteer">Volunteer</option>
                        <option value="locum">Locum</option>
                        <option value="visiting-practitioner">Visiting Practitioner</option>
                      </Select>
                    </Field>
                    <Field label="Start Date">
                      <Input
                        type="date"
                        value={form.startDate}
                        onChange={(e) => handleFieldChange("startDate", e.target.value)}
                        required
                      />
                    </Field>
                  </div>
                </Card>

                <Card title="Professional Cadre" description="Select your professional category. This determines which roles and permissions are relevant to you.">
                  <Field label="Professional Cadre" htmlFor="cadre">
                    <Select
                      id="cadre"
                      value={form.cadreCode ?? ""}
                      onChange={(e) => handleCadreChange(e.target.value)}
                      required={!form.customTitle}
                    >
                      <option value="">Select your cadre...</option>
                      {filteredCadres.map((cadre) => (
                        <option key={cadre.code} value={cadre.code}>
                          {cadre.name} ({cadre.category}){cadre.requiresRegistration ? " *" : ""}
                        </option>
                      ))}
                      <option value="other">Other - Request a custom title</option>
                    </Select>
                  </Field>
                  {form.cadreCode === "other" && (
                    <CustomTitleSection
                      form={form}
                      onChange={handleFieldChange}
                      specialties={filteredSpecialties}
                      departments={filteredDepartments}
                    />
                  )}
                </Card>

                {form.cadreCode && form.cadreCode !== "other" && (
                  <Card title="Job Title" description="Select your job title. Titles are filtered based on your selected cadre and will further filter by department.">
                    <Field label="Job Title" htmlFor="title">
                      <SearchSelect
                        id="title"
                        value={form.titleCode ?? ""}
                        onChange={handleTitleChange}
                        placeholder="Search job titles..."
                        options={[
                          ...filteredTitles.map((title) => ({
                            value: title.code,
                            label: title.name,
                            description: `${title.cadreCode} - ${title.departmentCodes.join(", ")}`,
                          })),
                          { value: "other", label: "Other - Request a custom title" },
                        ]}
                      />
                    </Field>
                    {form.titleCode === "other" && (
                      <CustomTitleSection
                        form={form}
                        onChange={handleFieldChange}
                        specialties={filteredSpecialties}
                        departments={filteredDepartments}
                      />
                    )}
                    {selectedTitle && (
                      <div className="mv-stack" style={{ marginTop: 16, padding: 16, background: "var(--mv-surface-subtle)", borderRadius: 8 }}>
                        <h4 style={{ margin: 0, fontSize: "1rem" }}>Selected Title Details</h4>
                        <div className="mv-grid mv-grid--2" style={{ marginTop: 8 }}>
                          <div>
                            <div className="mv-small mv-muted">Seniority</div>
                            <div><Badge tone="info">{selectedTitle.seniority}</Badge></div>
                          </div>
                          <div>
                            <div className="mv-small mv-muted">Credential Required</div>
                            <div><Badge tone={selectedTitle.requiresCredential ? "warning" : "success"}>
                              {selectedTitle.requiresCredential ? "Yes" : "No"}
                            </Badge></div>
                          </div>
                          <div>
                            <div className="mv-small mv-muted">Suggested Roles</div>
                            <div>{selectedTitle.suggestedSystemRoles.join(", ") || "None"}</div>
                          </div>
                          <div>
                            <div className="mv-small mv-muted">Privileges</div>
                            <div>{selectedTitle.privilegeCodes.join(", ") || "None"}</div>
                          </div>
                        </div>
                        <p className="mv-small mv-muted" style={{ marginTop: 8, marginBottom: 0 }}>
                          Note: Selecting a title does not automatically grant any permissions. All privileges require facility approval.
                        </p>
                      </div>
                    )}
                  </Card>
                )}

                {form.cadreCode && form.cadreCode !== "other" && form.titleCode !== "other" && (
                  <Card title="Department Assignment" description="Select the department(s) you'll be working in. A title can be used in multiple departments.">
                    <Field label="Primary & Additional Departments" htmlFor="departments">
                      <div className="mv-row" style={{ flexWrap: "wrap", gap: 12 }}>
                        {filteredDepartments.map((dept) => {
                          const isSelected = form.departmentCodes.includes(dept.code);
                          return (
                            <label key={dept.code} className="mv-small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                type={form.departmentCodes.length === 0 ? "radio" : "checkbox"}
                                checked={isSelected}
                                onChange={() => {
                                  if (form.departmentCodes.length === 0) {
                                    handleDepartmentChange([dept.code]);
                                  } else {
                                    const newDepts = isSelected
                                      ? form.departmentCodes.filter(d => d !== dept.code)
                                      : [...form.departmentCodes, dept.code];
                                    handleDepartmentChange(newDepts);
                                  }
                                }}
                              />
                              {dept.name}
                            </label>
                          );
                        })}
                      </div>
                      <span className="mv-field__hint">
                        Select at least one department. You can be assigned to multiple departments.
                      </span>
                    </Field>
                  </Card>
                )}

                {filteredSpecialties.length > 0 && (
                  <Card title="Specialty / Work Assignment" description="Select any specialties or work assignments that apply to your role.">
                    <Field label="Specialties" htmlFor="specialties">
                      <div className="mv-row" style={{ flexWrap: "wrap", gap: 12 }}>
                        {filteredSpecialties.map((specialty) => {
                          const isSelected = form.specialtyCodes.includes(specialty.code);
                          return (
                            <label key={specialty.code} className="mv-small" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => {
                                  const newSpecialties = isSelected
                                    ? form.specialtyCodes.filter(s => s !== specialty.code)
                                    : [...form.specialtyCodes, specialty.code];
                                  handleSpecialtyChange(newSpecialties);
                                }}
                              />
                              {specialty.name}
                            </label>
                          );
                        })}
                      </div>
                      <span className="mv-field__hint">
                        Specialties are recorded separately from your job title and do not grant additional permissions.
                      </span>
                    </Field>
                  </Card>
                )}

                {showCredentialFields && (
                  <Card
                    title="Professional Credentials"
                    description="Collecting professional credentials helps verify your qualifications. No document upload or self-declaration proves a licence is valid without manual verification."
                  >
                    <Notice tone="warning" title="Verification Required">
                      <strong>A document upload or self-declaration does not prove a licence is valid.</strong> 
                      Your credentials will be manually reviewed by the facility.
                    </Notice>
                    
                    {selectedCadre && (
                      <div className="mv-stack">
                        <h4>Regulatory Information</h4>
                        {selectedCadre.regulatorCodes.length > 0 ? (
                          <p className="mv-small">
                            This cadre is typically regulated by: 
                            <strong>{selectedCadre.regulatorCodes.map(r => 
                              catalogue.data?.catalogue.regulators.find(reg => reg.code === r)?.name ?? r
                            ).join(", ")}</strong>
                          </p>
                        ) : (
                          <p className="mv-small mv-muted">No specific regulator recorded for this cadre.</p>
                        )}
                        
                        <Notice tone="info">
                          Credential requirements are determined by facility policy. 
                          Some facilities may require additional documentation or verification steps.
                        </Notice>
                      </div>
                    )}

                    <div className="mv-stack" style={{ marginTop: 16 }}>
                      <h4>Next Steps</h4>
                      <p className="mv-small">
                        After completing this onboarding form, you will need to:
                      </p>
                      <ol className="mv-small" style={{ paddingLeft: 20 }}>
                        <li>Submit supporting documents (if required by facility policy)</li>
                        <li>Await manual verification by the credentialing officer</li>
                        <li>Complete any required training or orientation</li>
                        <li>Receive facility approval for your role assignments</li>
                      </ol>
                      <p className="mv-small mv-muted">
                        <strong>Important:</strong> Even with verified credentials, you will not receive clinical privileges 
                        until your facility administrator explicitly approves your role assignments.
                      </p>
                    </div>
                  </Card>
                )}

                <Card title="Review & Submit" description="Review your information before submission.">
                  <div className="mv-stack">
                    <h4>Summary</h4>
                    <div className="mv-grid mv-grid--2" style={{ fontSize: "0.9rem" }}>
                      <div>
                        <div className="mv-small mv-muted">Account Type</div>
                        <div>{catalogue.data?.accountTypes.find(a => a.code === form.accountType)?.label ?? form.accountType}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Facility</div>
                        <div>{facilities.data?.facilities.find(f => f.id === form.facilityId)?.name ?? "Not selected"}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Name</div>
                        <div>{form.familyName}, {form.givenName}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Engagement Type</div>
                        <div>{form.engagementType}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Start Date</div>
                        <div>{form.startDate}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Cadre</div>
                        <div>{selectedCadre?.name ?? form.cadreCode ?? "Not selected"}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Job Title</div>
                        <div>{selectedTitle?.name ?? form.customTitle ?? "Not selected"}</div>
                      </div>
                      <div>
                        <div className="mv-small mv-muted">Departments</div>
                        <div>{form.departmentCodes.map(d => 
                          catalogue.data?.catalogue.departments.find(dept => dept.code === d)?.name ?? d
                        ).join(", ") || "Not selected"}</div>
                      </div>
                    </div>
                    
                    {form.customTitle && (
                      <div className="mv-stack" style={{ marginTop: 16, padding: 12, background: "var(--mv-surface-subtle)", borderRadius: 6 }}>
                        <h5 style={{ margin: 0 }}>Custom Title Request</h5>
                        <p style={{ margin: "8px 0 0 0", fontSize: "0.9rem" }}>
                          <strong>Proposed Title:</strong> {form.customTitle}
                        </p>
                        <p style={{ margin: "4px 0 0 0", fontSize: "0.8rem" }} className="mv-muted">
                          This custom title request will remain pending until reviewed and approved by a facility administrator. 
                          <strong>It will not grant any permissions until approved.</strong>
                        </p>
                      </div>
                    )}

                    <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12, marginTop: 24 }}>
                      <Button variant="ghost" type="button" onClick={() => navigate("/")}>
                        Cancel
                      </Button>
                      <Button type="submit" disabled={!isFormValid || action.busy !== null}>
                        {action.busy === null ? "Submit Onboarding" : "Submitting..."}
                      </Button>
                    </div>
                  </div>
                </Card>
              </>
            )}
          </>
        )}
      </form>
    </div>
  );
}

// Patient onboarding section
function PatientOnboardingSection({
  form,
  onChange,
}: {
  form: OnboardingFormState;
  onChange: (field: keyof OnboardingFormState, value: string) => void;
}) {
  return (
    <div className="mv-stack">
      <Card title="Patient Information" description="Create your patient identity. You'll receive a unique public ID to access your health records.">
        <div className="mv-form-grid">
          <Field label="Given Name" htmlFor="patient-given-name">
            <Input
              id="patient-given-name"
              value={form.givenName}
              onChange={(e) => onChange("givenName", e.target.value)}
              required
              minLength={1}
              maxLength={120}
            />
          </Field>
          <Field label="Family Name" htmlFor="patient-family-name">
            <Input
              id="patient-family-name"
              value={form.familyName}
              onChange={(e) => onChange("familyName", e.target.value)}
              required
              minLength={1}
              maxLength={120}
            />
          </Field>
        </div>
        <div className="mv-form-grid">
          <Field label="Date of Birth" htmlFor="patient-dob">
            <Input
              id="patient-dob"
              type="date"
              value={form.startDate}
              onChange={(e) => onChange("startDate", e.target.value)}
              required
            />
          </Field>
          <Field label="Sex">
            <Select value={form.engagementType} onChange={(e) => onChange("engagementType", e.target.value)}>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
              <option value="unknown">Prefer not to say</option>
            </Select>
          </Field>
        </div>
        <Field label="Phone Number" htmlFor="patient-phone">
          <Input
            id="patient-phone"
            type="tel"
            value={form.phone ?? ""}
            onChange={(e) => onChange("phone", e.target.value)}
            placeholder="Optional"
          />
        </Field>
        <Field label="Email" htmlFor="patient-email">
          <Input
            id="patient-email"
            type="email"
            value={form.email ?? ""}
            onChange={(e) => onChange("email", e.target.value)}
            placeholder="Optional"
          />
        </Field>
      </Card>

      <Card title="Patient Access" description="Understand how your health information is shared and protected.">
        <div className="mv-stack">
          <h4>Your Rights</h4>
          <ul className="mv-small" style={{ paddingLeft: 20 }}>
            <li>Your public patient ID locates your identity but <strong>never authorizes record access by itself</strong></li>
            <li>Only you can grant access to your health records through explicit consent</li>
            <li>You can invite caregivers (family members, friends) to access your information</li>
            <li>You control what information each caregiver can see</li>
            <li>You can revoke access at any time</li>
          </ul>
          
          <h4>Privacy & Security</h4>
          <ul className="mv-small" style={{ paddingLeft: 20 }}>
            <li>All access to your records is logged and audited</li>
            <li>Healthcare facilities can only access information you've explicitly released</li>
            <li>Emergency access is time-limited and requires special authorization</li>
            <li>Your data is protected by tenant isolation - one facility cannot see another's records</li>
          </ul>
        </div>
      </Card>

      <Card>
        <div className="mv-row" style={{ justifyContent: "flex-end", gap: 12 }}>
          <Button variant="ghost" type="button" onClick={() => window.location.assign("/")}>
            Cancel
          </Button>
          <Button type="submit">
            Continue to Registration
          </Button>
        </div>
      </Card>
    </div>
  );
}

// Custom title request section
function CustomTitleSection({
  form,
  onChange,
  specialties,
  departments,
}: {
  form: OnboardingFormState;
  onChange: (field: keyof OnboardingFormState, value: string) => void;
  specialties: CatalogueSpecialty[];
  departments: CatalogueDepartment[];
}) {
  return (
    <div className="mv-stack" style={{ 
      padding: 16, 
      background: "var(--mv-surface-subtle)", 
      borderRadius: 8,
      marginTop: 16 
    }}>
      <h4 style={{ margin: 0 }}>Request a Custom Title</h4>
      <p className="mv-small mv-muted" style={{ margin: "8px 0 16px 0" }}>
        If your specific role isn't listed in the catalogue, you can request a custom title. 
        This will be reviewed by a facility administrator.
      </p>
      
      <Field label="Proposed Title" htmlFor="custom-title">
        <Input
          id="custom-title"
          value={form.customTitle ?? ""}
          onChange={(e) => onChange("customTitle", e.target.value)}
          placeholder="Enter your proposed job title"
          required
          minLength={2}
        />
      </Field>
      
      <Field label="Explanation" htmlFor="custom-explanation">
        <Textarea
          id="custom-explanation"
          value={form.customTitleExplanation ?? ""}
          onChange={(e) => onChange("customTitleExplanation", e.target.value)}
          placeholder="Explain why this title is needed and what role it represents"
          minLength={10}
          rows={3}
        />
      </Field>
      
      <Field label="Related Specialty (optional)">
        <Select
          value={form.specialtyCodes[0] ?? ""}
          onChange={(e) => onChange("specialtyCodes", JSON.stringify([e.target.value]))}
        >
          <option value="">Select a specialty...</option>
          {specialties.map((s) => (
            <option key={s.code} value={s.code}>{s.name}</option>
          ))}
        </Select>
      </Field>
      
      <Field label="Related Department (optional)">
        <Select
          value={form.departmentCodes[0] ?? ""}
          onChange={(e) => onChange("departmentCodes", JSON.stringify([e.target.value]))}
        >
          <option value="">Select a department...</option>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>{d.name}</option>
          ))}
        </Select>
      </Field>
      
      <Notice tone="warning" title="Important Notice">
        <p style={{ margin: 0, fontSize: "0.85rem" }}>
          <strong>A custom title request stays pending until reviewed and approved.</strong> 
          It does not grant any system role, clinical privilege, or facility access.
        </p>
      </Notice>
    </div>
  );
}
