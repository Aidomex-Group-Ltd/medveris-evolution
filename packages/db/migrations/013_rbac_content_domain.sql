-- Role-based access control extensions: care-team relationships, patient
-- proxies, expiring role grants, and a versioned non-clinical content domain.
-- Content is deliberately separate from patient records and never carries PHI.

BEGIN;

-- Additional application roles and platform roles. "Specialist" remains a
-- professional attribute (cadre/specialty + privileges), not a global role.
ALTER TABLE platform_roles DROP CONSTRAINT IF EXISTS platform_roles_role_check;
ALTER TABLE platform_roles ADD CONSTRAINT platform_roles_role_check
  CHECK (role IN ('credential_reviewer','platform_operator','auditor','content_editor','content_reviewer'));

-- Explicit care-team relationships replace "clinical role sees every patient".
CREATE TABLE care_team_members (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  staff_person_id uuid REFERENCES staff_persons(id),
  relationship text NOT NULL CHECK (relationship IN (
    'primary','covering','consulting','multidisciplinary','nursing','diagnostic'
  )),
  department_id uuid REFERENCES departments(id),
  purpose text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','revoked')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR staff_person_id IS NOT NULL),
  CHECK (ends_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX care_team_patient_idx ON care_team_members(tenant_id, patient_id, status, ends_at);
CREATE INDEX care_team_user_idx ON care_team_members(user_id, tenant_id, status, ends_at);

-- Delegated patient access for guardians/proxies. Scopes and dates are always
-- explicit; a proxy does not inherit every patient right.
CREATE TABLE patient_proxies (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  proxy_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship text NOT NULL,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_via text NOT NULL DEFAULT 'patient-delegation',
  revoked_at timestamptz,
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at),
  CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);
CREATE INDEX patient_proxies_user_idx ON patient_proxies(proxy_user_id, status, expires_at);
CREATE INDEX patient_proxies_patient_idx ON patient_proxies(patient_id, status);

-- Role grants add explicit scope, approval and expiry without replacing the
-- membership baseline. Effective roles are the union of membership roles and
-- approved, unexpired grants, revalidated on every request.
CREATE TABLE role_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  department_id uuid REFERENCES departments(id),
  scope_note text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','approved','rejected','revoked','expired'
  )),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  decision_reason text,
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX role_grants_user_idx ON role_grants(tenant_id, user_id, status, expires_at);

-- Versioned content catalogue. tenant_id NULL means platform-wide content.
CREATE TABLE content_sources (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN (
    'public-health-authority','government','professional-body','journal-index',
    'institutional','opportunity-board','manual'
  )),
  base_url text,
  rss_url text,
  status text NOT NULL DEFAULT 'configured' CHECK (status IN (
    'configured','available','unavailable','disabled'
  )),
  last_checked_at timestamptz,
  last_error text,
  terms_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_items (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN (
    'public-health-advisory','health-education','research-update','guideline',
    'professional-learning','facility-announcement'
  )),
  slug text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  body text,
  source_id uuid REFERENCES content_sources(id),
  source_organization text,
  source_url text,
  publication_date date,
  retrieval_date date NOT NULL DEFAULT current_date,
  language text NOT NULL DEFAULT 'en',
  geography text,
  audience text NOT NULL DEFAULT 'general' CHECK (audience IN (
    'general','patient','professional','specialty','organization','department'
  )),
  specialty_tags text[] NOT NULL DEFAULT '{}',
  visibility_scope text NOT NULL DEFAULT 'public' CHECK (visibility_scope IN (
    'public','authenticated','patient','professional','specialty','organization','department'
  )),
  visibility_values text[] NOT NULL DEFAULT '{}',
  attribution text,
  reuse_terms text,
  sponsorship_disclosure text,
  study_type text,
  population text,
  findings_summary text,
  limitations text,
  peer_review_status text CHECK (peer_review_status IS NULL OR peer_review_status IN (
    'peer-reviewed','preprint','not-applicable','unknown'
  )),
  correction_status text NOT NULL DEFAULT 'none' CHECK (correction_status IN (
    'none','corrected','retracted'
  )),
  correction_note text,
  clinical_reviewed boolean NOT NULL DEFAULT false,
  editorial_priority integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','in-review','published','archived','withdrawn'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  author_user_id uuid NOT NULL REFERENCES users(id),
  editor_user_id uuid REFERENCES users(id),
  reviewer_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_due_on date,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR (reviewed_at IS NOT NULL AND reviewer_user_id IS NOT NULL)),
  CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  UNIQUE (tenant_id, slug, version)
);
CREATE INDEX content_items_feed_idx ON content_items(status, visibility_scope, publication_date DESC);
CREATE INDEX content_items_tenant_idx ON content_items(tenant_id, status, updated_at DESC);
CREATE INDEX content_items_tags_idx ON content_items USING gin(specialty_tags);

CREATE TABLE content_item_versions (
  id uuid PRIMARY KEY,
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  change_note text NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version)
);

CREATE TABLE opportunities (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  content_item_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  opportunity_type text NOT NULL CHECK (opportunity_type IN (
    'employment','locum','cpd','conference','fellowship','training','research-collaboration',
    'community-screening','health-education','patient-support','study-participation'
  )),
  title text NOT NULL,
  description text NOT NULL,
  organization text NOT NULL,
  audience text NOT NULL DEFAULT 'professional' CHECK (audience IN ('patient','professional','both')),
  specialty_tags text[] NOT NULL DEFAULT '{}',
  eligibility text,
  location text,
  remote boolean NOT NULL DEFAULT false,
  application_url text,
  contact_route text,
  opens_on date,
  closes_on date,
  compensation text,
  cpd_details text,
  source_evidence text,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN (
    'unverified','details-checked','source-verified','withdrawn'
  )),
  verified_checks text,
  sponsorship_status text NOT NULL DEFAULT 'none' CHECK (sponsorship_status IN (
    'none','sponsored','unknown'
  )),
  moderation_state text NOT NULL DEFAULT 'draft' CHECK (moderation_state IN (
    'draft','pending-review','published','rejected','archived','withdrawn'
  )),
  report_count integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  author_user_id uuid NOT NULL REFERENCES users(id),
  reviewer_user_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_on IS NULL OR opens_on IS NULL OR closes_on >= opens_on),
  CHECK (application_url IS NULL OR application_url ~ '^https?://'),
  CHECK (moderation_state <> 'published' OR reviewed_at IS NOT NULL)
);
CREATE INDEX opportunities_feed_idx ON opportunities(moderation_state, audience, closes_on);
CREATE INDEX opportunities_tags_idx ON opportunities USING gin(specialty_tags);

CREATE TABLE content_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language text NOT NULL DEFAULT 'en',
  geography text,
  specialty_tags text[] NOT NULL DEFAULT '{}',
  interests text[] NOT NULL DEFAULT '{}',
  hide_patient_opportunities boolean NOT NULL DEFAULT false,
  hide_professional_opportunities boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_bookmarks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_item_id uuid REFERENCES content_items(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((content_item_id IS NOT NULL)::int + (opportunity_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX content_bookmarks_content_unique ON content_bookmarks(user_id, content_item_id)
  WHERE content_item_id IS NOT NULL;
CREATE UNIQUE INDEX content_bookmarks_opportunity_unique ON content_bookmarks(user_id, opportunity_id)
  WHERE opportunity_id IS NOT NULL;

CREATE TABLE content_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES users(id),
  content_item_id uuid REFERENCES content_items(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES opportunities(id) ON DELETE CASCADE,
  reason text NOT NULL,
  detail text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed','actioned')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((content_item_id IS NOT NULL)::int + (opportunity_id IS NOT NULL)::int = 1)
);
CREATE INDEX content_reports_status_idx ON content_reports(status, created_at);

CREATE OR REPLACE FUNCTION app.is_content_editor() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.platform_role', true), ''), '') IN ('content_editor','content_reviewer')
$$;

CREATE TRIGGER content_versions_immutable BEFORE UPDATE OR DELETE ON content_item_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- RLS -----------------------------------------------------------------------
ALTER TABLE care_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE care_team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY care_team_access ON care_team_members USING (
  tenant_id = app.current_tenant()
  AND (app.has_any_role(ARRAY['clinician','nurse','facility_admin','quality','auditor']) OR user_id = app.current_user())
) WITH CHECK (
  tenant_id = app.current_tenant()
  AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
);

ALTER TABLE patient_proxies ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_proxies FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_proxies_access ON patient_proxies USING (
  proxy_user_id = app.current_user() OR patient_id = app.current_patient()
  OR (app.current_tenant() IS NOT NULL AND app.has_any_role(ARRAY['facility_admin','records','auditor']))
) WITH CHECK (
  patient_id = app.current_patient()
  OR (app.current_tenant() IS NOT NULL AND app.has_any_role(ARRAY['facility_admin','records']))
);

ALTER TABLE role_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY role_grants_access ON role_grants USING (
  user_id = app.current_user()
  OR (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','hr','auditor']))
) WITH CHECK (
  tenant_id = app.current_tenant()
  AND app.has_any_role(ARRAY['facility_admin','hr'])
);

ALTER TABLE content_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY content_sources_read ON content_sources FOR SELECT USING (
  app.current_user() IS NOT NULL
  OR (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality']))
);
CREATE POLICY content_sources_write ON content_sources FOR ALL USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','content_editor']))
  OR (tenant_id IS NULL AND app.is_content_editor())
) WITH CHECK (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','content_editor']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);

ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;
CREATE POLICY content_items_read ON content_items FOR SELECT USING (
  (status = 'published' AND visibility_scope = 'public')
  OR (app.actor_kind() = 'patient' AND status = 'published'
      AND visibility_scope IN ('public','authenticated','patient'))
  OR (app.actor_kind() = 'staff' AND status = 'published'
      AND visibility_scope IN ('public','authenticated','professional','specialty','organization','department'))
  OR (tenant_id = app.current_tenant()
      AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality','auditor']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);
CREATE POLICY content_items_write ON content_items FOR ALL USING (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality']))
  OR (tenant_id IS NULL AND app.is_content_editor())
) WITH CHECK (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);

ALTER TABLE content_item_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_item_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY content_versions_access ON content_item_versions USING (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality','auditor']))
  OR (tenant_id IS NULL AND app.is_content_editor())
) WITH CHECK (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);

ALTER TABLE opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunities FORCE ROW LEVEL SECURITY;
CREATE POLICY opportunities_read ON opportunities FOR SELECT USING (
  moderation_state = 'published'
  OR (tenant_id = app.current_tenant()
      AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','auditor']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);
CREATE POLICY opportunities_write ON opportunities FOR ALL USING (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer']))
  OR (tenant_id IS NULL AND app.is_content_editor())
) WITH CHECK (
  (tenant_id = app.current_tenant()
   AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer']))
  OR (tenant_id IS NULL AND app.is_content_editor())
);

ALTER TABLE content_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY content_preferences_self ON content_preferences USING (user_id = app.current_user())
  WITH CHECK (user_id = app.current_user());

ALTER TABLE content_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_bookmarks FORCE ROW LEVEL SECURITY;
CREATE POLICY content_bookmarks_self ON content_bookmarks USING (user_id = app.current_user())
  WITH CHECK (user_id = app.current_user());

ALTER TABLE content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY content_reports_insert ON content_reports FOR INSERT WITH CHECK (reporter_user_id = app.current_user());
CREATE POLICY content_reports_read ON content_reports FOR SELECT USING (
  reporter_user_id = app.current_user()
  OR (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality']))
  OR app.is_content_editor()
);
CREATE POLICY content_reports_update ON content_reports FOR UPDATE USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','content_editor','content_reviewer','quality']))
  OR app.is_content_editor()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  care_team_members, patient_proxies, role_grants, content_sources, content_items,
  content_item_versions, opportunities, content_preferences, content_bookmarks, content_reports
TO medveris_runtime;

REVOKE UPDATE, DELETE ON content_item_versions FROM medveris_runtime;

COMMIT;
