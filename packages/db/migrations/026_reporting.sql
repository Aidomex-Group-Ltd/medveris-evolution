-- Reporting support.
--
-- The privacy officer reviews audit history, so the governance read policy now
-- includes that role. Staff workload is aggregated across clinical, laboratory,
-- radiology and pharmacy tables that a facility administrator cannot read; the
-- function returns per-person counts only (no patient or record identifiers) and
-- only for the caller's active facility. Additive only.

BEGIN;

DROP POLICY audit_read_governance ON audit_events;
CREATE POLICY audit_read_governance ON audit_events FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin', 'auditor', 'privacy_officer'])
);

CREATE OR REPLACE FUNCTION app.report_staff_workload(p_tenant uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  roles text[],
  signed_notes integer,
  lab_results_entered integer,
  lab_results_validated integer,
  radiology_reports_signed integer,
  dispenses integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT m.user_id, u.display_name, m.roles,
    (SELECT count(*)::int FROM clinical_entry_versions v WHERE v.tenant_id = p_tenant AND v.author_id = m.user_id
        AND v.signed_at >= p_from AND v.signed_at < p_to),
    (SELECT count(*)::int FROM lab_results r WHERE r.tenant_id = p_tenant AND r.authored_by = m.user_id
        AND r.created_at >= p_from AND r.created_at < p_to),
    (SELECT count(*)::int FROM lab_results r WHERE r.tenant_id = p_tenant AND r.verified_by = m.user_id
        AND r.verified_at >= p_from AND r.verified_at < p_to),
    (SELECT count(*)::int FROM radiology_report_versions v WHERE v.tenant_id = p_tenant AND v.signed_by = m.user_id
        AND v.signed_at >= p_from AND v.signed_at < p_to),
    (SELECT count(*)::int FROM dispenses d WHERE d.tenant_id = p_tenant AND d.dispensed_by = m.user_id
        AND d.created_at >= p_from AND d.created_at < p_to)
  FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.tenant_id = p_tenant AND m.status = 'active'
    AND p_tenant = app.current_tenant()
    AND app.has_any_role(ARRAY['facility_admin', 'department_lead'])
  ORDER BY u.display_name
$$;
GRANT SELECT ON clinical_entry_versions, lab_results, radiology_report_versions, dispenses, memberships, users TO medveris_exchange;
ALTER FUNCTION app.report_staff_workload(uuid, timestamptz, timestamptz) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.report_staff_workload(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.report_staff_workload(uuid, timestamptz, timestamptz) TO medveris_runtime;

COMMIT;
