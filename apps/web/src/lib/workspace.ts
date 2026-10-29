import { primaryDepartmentForCategory, serviceCategory, WORKFLOW_DEPARTMENT_LABELS, type WorkflowDepartment } from "@medveris/domain";
import type { ActiveTenant } from "./types";

export interface WorkspaceProfile {
  /** Enabled module codes; null means every module (workspaces created before module selection). */
  modules: Set<string> | null;
  /** The department a standalone laboratory, imaging centre or pharmacy exists to run. */
  unitDepartment: WorkflowDepartment | null;
  /** Not linked to an organization: no organization-only screens. */
  independent: boolean;
  categoryLabel: string | null;
}

export function workspaceProfile(active: ActiveTenant | null | undefined): WorkspaceProfile {
  const workspace = active?.workspace ?? null;
  const category = workspace?.serviceCategory ?? null;
  let categoryLabel: string | null = null;
  try {
    categoryLabel = category ? serviceCategory(category).label : null;
  } catch {
    categoryLabel = null;
  }
  return {
    modules: workspace?.enabledModules?.length ? new Set(workspace.enabledModules) : null,
    unitDepartment: primaryDepartmentForCategory(category),
    independent: !workspace?.organizationId,
    categoryLabel,
  };
}

export function hasModule(profile: WorkspaceProfile, ...modules: string[]): boolean {
  return profile.modules === null || modules.some((module) => profile.modules!.has(module));
}

export function departmentLabel(department: string): string {
  return WORKFLOW_DEPARTMENT_LABELS[department as WorkflowDepartment] ?? department;
}

/** Modules that make each department's queue relevant to a workspace. */
export const DEPARTMENT_MODULES: Record<WorkflowDepartment, string[]> = {
  laboratory: ["laboratory"],
  imaging: ["radiology"],
  theatre: ["theatre"],
  pharmacy: ["pharmacy"],
  procedure: ["outpatient", "emergency", "inpatient"],
  other: ["outpatient", "emergency", "inpatient"],
};
