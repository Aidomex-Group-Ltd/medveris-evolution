-- Onboarding review hardening: custom title requests, credential policy and
-- append-only credential review history.
--
-- A custom title request never creates a job title, privilege or system role by
-- itself. It stays pending until an authorised facility reviewer records a
-- decision. Credential review history is append-only so an expiry or suspension
-- decision cannot erase the earlier verification evidence.

BEGIN;

-- Custom titles requested during onboarding. The proposed label is kept in
-- this request table and is not written to job_titles until approval.
CREATE TABLE job_title_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  onboarding_case_id uuid REFERENCES onboarding_cases(id) ON DELETE SET NULL,
  proposed_name text NOT NULL,
  cadre_code text,
  department_codes text[] NOT NULL DEFAULT '{}',
  specialty_codes text[] NOT NULL DEFAULT '{}',
  explanation text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  approved_job_title_id uuid REFERENCES job_titles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND approved_job_title_id IS NOT NULL)),
  CHECK (status <> 'rejected' OR (reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL))
);
CREATE INDEX job_title_requests_tenant_status_idx ON job_title_requests(tenant_id, status, created_at);
CREATE INDEX job_title_requests_requester_idx ON job_title_requests(requested_by, created_at);
CREATE UNIQUE INDEX job_title_requests_pending_name ON job_title_requests(tenant_id, lower(proposed_name))
  WHERE status = 'pending';

ALTER TABLE job_title_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_title_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY job_title_requests_read ON job_title_requests FOR SELECT USING (
  tenant_id = app.current_tenant()
  AND (
    requested_by = app.current_user()
    OR app.has_any_role(ARRAY['facility_admin','hr','records','auditor'])
  )
  OR app.is_platform_operator()
);
CREATE POLICY job_title_requests_insert ON job_title_requests FOR INSERT WITH CHECK (
  tenant_id = app.current_tenant() AND requested_by = app.current_user()
);
CREATE POLICY job_title_requests_update ON job_title_requests FOR UPDATE USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr'])
);
GRANT SELECT, INSERT, UPDATE ON job_title_requests TO medveris_runtime;

-- The selected catalogue values stay separate from the custom label. These
-- columns are nullable so existing onboarding cases are unaffected.
ALTER TABLE onboarding_cases
  ADD COLUMN specialty_codes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN custom_title_request_id uuid REFERENCES job_title_requests(id),
  ADD COLUMN credential_policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX onboarding_custom_title_idx ON onboarding_cases(custom_title_request_id);

-- Professional credential detail. Regulator and licence identifiers are
-- separate from the credential number so manual verification can record the
-- exact authority and scope without implying validity.
ALTER TABLE credentials
  ADD COLUMN registration_number text,
  ADD COLUMN licence_number text,
  ADD COLUMN qualifications text,
  ADD COLUMN specialty_credentials text[] NOT NULL DEFAULT '{}',
  ADD COLUMN verification_method text NOT NULL DEFAULT 'manual',
  ADD COLUMN verification_source text;

-- Every decision keeps its own row. Runtime roles may insert and read, but the
-- append-only trigger rejects UPDATE and DELETE.
CREATE TABLE credential_review_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id),
  previous_status text,
  decision text NOT NULL,
  new_status text NOT NULL,
  reason text NOT NULL,
  verification_method text NOT NULL DEFAULT 'manual',
  checks_performed text,
  decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_review_events_credential_idx ON credential_review_events(credential_id, decided_at);
CREATE INDEX credential_review_events_tenant_idx ON credential_review_events(tenant_id, decided_at);
CREATE TRIGGER credential_review_events_immutable BEFORE UPDATE OR DELETE ON credential_review_events
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();

ALTER TABLE credential_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_review_events FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_review_events_read ON credential_review_events FOR SELECT USING (
  app.is_platform_reviewer()
  OR app.is_platform_operator()
  OR (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr','records','auditor']))
  OR EXISTS (
    SELECT 1 FROM credentials c
     WHERE c.id = credential_review_events.credential_id
       AND (c.subject_user_id = app.current_user() OR c.submitted_by = app.current_user())
  )
);
CREATE POLICY credential_review_events_insert ON credential_review_events FOR INSERT WITH CHECK (
  app.is_platform_reviewer()
  OR app.is_platform_operator()
  OR (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr']))
);
GRANT SELECT, INSERT ON credential_review_events TO medveris_runtime;

-- Facility credential policy. A facility can require documents or a licence
-- expiry for a cadre while another facility applies a different policy.
CREATE TABLE facility_credential_policies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cadre_code text,
  credential_type text NOT NULL,
  regulator_code text,
  requires_document boolean NOT NULL DEFAULT true,
  requires_licence boolean NOT NULL DEFAULT true,
  review_required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  notes text,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX facility_credential_policies_key
  ON facility_credential_policies(tenant_id, coalesce(cadre_code, ''), credential_type);
CREATE INDEX facility_credential_policies_tenant_idx ON facility_credential_policies(tenant_id, active);

ALTER TABLE facility_credential_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_credential_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY facility_credential_policies_read ON facility_credential_policies FOR SELECT USING (
  tenant_id = app.current_tenant() OR app.is_platform_operator()
);
CREATE POLICY facility_credential_policies_write ON facility_credential_policies FOR ALL USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr'])
);
GRANT SELECT, INSERT, UPDATE ON facility_credential_policies TO medveris_runtime;

-- A facility reviewer can see credentials attached to an onboarding case owned
-- by their facility. This does not expose credentials belonging to another
-- facility and does not make the reviewer a platform credential verifier.
CREATE POLICY credentials_facility_review_read ON credentials FOR SELECT USING (
  app.current_tenant() IS NOT NULL
  AND app.has_any_role(ARRAY['facility_admin','hr','records','auditor'])
  AND onboarding_case_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM onboarding_cases o
     WHERE o.id = credentials.onboarding_case_id
       AND o.tenant_id = app.current_tenant()
  )
);
CREATE POLICY credentials_facility_review_update ON credentials FOR UPDATE USING (
  app.current_tenant() IS NOT NULL
  AND app.has_any_role(ARRAY['facility_admin','hr'])
  AND onboarding_case_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM onboarding_cases o
     WHERE o.id = credentials.onboarding_case_id
       AND o.tenant_id = app.current_tenant()
  )
) WITH CHECK (
  app.current_tenant() IS NOT NULL
  AND app.has_any_role(ARRAY['facility_admin','hr'])
  AND onboarding_case_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM onboarding_cases o
     WHERE o.id = credentials.onboarding_case_id
       AND o.tenant_id = app.current_tenant()
  )
);

-- A staff person may list their own affiliations across facilities. The rows
-- remain tenant-owned; this policy only exposes the person's own engagements.
CREATE POLICY engagements_self_affiliations ON engagements FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM staff_persons s
     WHERE s.id = engagements.staff_person_id
       AND s.user_id = app.current_user()
  )
);
CREATE POLICY onboarding_self_affiliations ON onboarding_cases FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM staff_persons s
     WHERE s.id = onboarding_cases.staff_person_id
       AND s.user_id = app.current_user()
  )
);

COMMIT;
