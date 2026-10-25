-- Medveris M0/M1 schema. Owned by medveris_migrator; runtime roles are separate.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO medveris_runtime, medveris_jobs, medveris_exchange;
GRANT CREATE ON SCHEMA app TO medveris_exchange;

CREATE OR REPLACE FUNCTION app.current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_patient() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.patient_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.actor_kind() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'anonymous')
$$;

CREATE OR REPLACE FUNCTION app.roles() RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(string_to_array(NULLIF(current_setting('app.roles', true), ''), ','), ARRAY[]::text[])
$$;

CREATE OR REPLACE FUNCTION app.has_any_role(required text[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.roles() && required
$$;

CREATE OR REPLACE FUNCTION app.is_platform_reviewer() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.platform_role', true), ''), '') = 'credential_reviewer'
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  given_name text NOT NULL,
  family_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  totp_secret_enc text,
  mfa_enrolled_at timestamptz,
  recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token text NOT NULL,
  active_tenant_id uuid,
  mfa_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  user_agent text,
  ip_address text
);
CREATE INDEX sessions_user_idx ON sessions(user_id, revoked_at, expires_at);

CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('login-mfa')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE email_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify-email','reset-password')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending',
  delivery_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  facility_type text NOT NULL DEFAULT 'outpatient',
  city text,
  country text NOT NULL DEFAULT 'Uganda',
  email text,
  phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  public_listing boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id, status);

CREATE TABLE platform_roles (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('credential_reviewer','platform_operator','auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  given_name text NOT NULL,
  family_name text NOT NULL,
  date_of_birth date NOT NULL,
  sex text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('female','male','other','unknown')),
  email text,
  phone text,
  national_id text,
  identity_confidence text NOT NULL DEFAULT 'confirmed-verbal'
    CHECK (identity_confidence IN ('confirmed-document','confirmed-verbal','temporary','uncertain')),
  identity_evidence text,
  created_via text NOT NULL DEFAULT 'self-registration'
    CHECK (created_via IN ('self-registration','assisted-registration','temporary-emergency','import')),
  created_tenant_id uuid REFERENCES tenants(id),
  merged_into uuid REFERENCES patients(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_name_idx ON patients(family_name, given_name);
CREATE INDEX patients_email_idx ON patients(lower(email));

CREATE TABLE patient_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patient_duplicate_candidates (
  id uuid PRIMARY KEY,
  primary_patient_id uuid NOT NULL REFERENCES patients(id),
  candidate_patient_id uuid NOT NULL REFERENCES patients(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed-no-merge','linked')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (primary_patient_id <> candidate_patient_id)
);

CREATE TABLE tenant_patient_links (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  local_mrn text,
  release_signed_records boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, patient_id)
);
CREATE UNIQUE INDEX tenant_local_mrn_unique ON tenant_patient_links(tenant_id, local_mrn) WHERE local_mrn IS NOT NULL;

CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  clinician_user_id uuid REFERENCES users(id),
  start_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL DEFAULT 20 CHECK (duration_minutes BETWEEN 5 AND 480),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','arrived','completed','cancelled','no-show')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_tenant_time_idx ON appointments(tenant_id, start_at);

CREATE TABLE queues (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE queue_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  queue_id uuid NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid,
  appointment_id uuid REFERENCES appointments(id),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','called','in-triage','with-clinician','completed','cancelled')),
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
  created_at timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX queue_entries_active_idx ON queue_entries(tenant_id, status, created_at);

CREATE TABLE encounters (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  appointment_id uuid REFERENCES appointments(id),
  queue_entry_id uuid REFERENCES queue_entries(id),
  clinician_user_id uuid REFERENCES users(id),
  type text NOT NULL DEFAULT 'walk-in' CHECK (type IN ('walk-in','scheduled','follow-up')),
  state text NOT NULL DEFAULT 'planned'
    CHECK (state IN ('planned','arrived','triaged','in-progress','completed','cancelled','entered-in-error')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  reason text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX encounters_tenant_state_idx ON encounters(tenant_id, state, opened_at);
CREATE INDEX encounters_patient_idx ON encounters(patient_id, opened_at);

ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_encounter_fk FOREIGN KEY (encounter_id) REFERENCES encounters(id);

CREATE TABLE triage_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  complaint text NOT NULL,
  urgency text NOT NULL CHECK (urgency IN ('routine','urgent','emergency')),
  notes text,
  nurse_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  loinc_system text NOT NULL,
  loinc_version text NOT NULL,
  loinc_code text NOT NULL,
  display text NOT NULL,
  original_text text,
  coding jsonb NOT NULL,
  value_num numeric,
  value_text text,
  unit_code text,
  unit_system text NOT NULL DEFAULT 'http://unitsofmeasure.org',
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  author_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'final' CHECK (status IN ('preliminary','final','amended','entered-in-error')),
  note text,
  sensitivity text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_patient_time_idx ON observations(patient_id, occurred_at);
CREATE INDEX observations_tenant_time_idx ON observations(tenant_id, occurred_at);

CREATE TABLE conditions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  snomed_system text NOT NULL DEFAULT 'http://snomed.info/sct',
  snomed_version text NOT NULL,
  snomed_code text NOT NULL,
  display text NOT NULL,
  original_text text,
  coding jsonb NOT NULL,
  clinical_status text NOT NULL DEFAULT 'active',
  onset_date date,
  note text,
  author_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  sensitivity text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX conditions_patient_idx ON conditions(patient_id, recorded_at);

CREATE TABLE allergies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  state text NOT NULL CHECK (state IN ('unknown','none','recorded')),
  substance_coding jsonb,
  reaction_coding jsonb,
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('mild','moderate','severe','unknown')),
  note text,
  author_id uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  sensitivity text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX allergies_patient_idx ON allergies(patient_id, recorded_at);

CREATE TABLE clinical_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed','amended','entered-in-error')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clinical_entries_patient_idx ON clinical_entries(patient_id, created_at);
CREATE INDEX clinical_entries_encounter_idx ON clinical_entries(encounter_id);

CREATE TABLE clinical_entry_versions (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES clinical_entries(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  previous_version_id uuid REFERENCES clinical_entry_versions(id),
  author_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  status text NOT NULL CHECK (status IN ('draft','signed','amended','entered-in-error')),
  change_note text NOT NULL CHECK (length(change_note) >= 5),
  title text NOT NULL,
  content_schema text NOT NULL DEFAULT 'urn:medveris:schema:outpatient-note:1',
  content jsonb NOT NULL,
  content_digest text NOT NULL,
  signature text,
  signature_key_id text,
  sensitivity text[] NOT NULL DEFAULT '{}',
  UNIQUE (entry_id, version),
  CHECK (version = 1 AND previous_version_id IS NULL OR version > 1 AND previous_version_id IS NOT NULL),
  CHECK (status IN ('draft','entered-in-error') OR signed_at IS NOT NULL)
);
CREATE INDEX versions_tenant_time_idx ON clinical_entry_versions(tenant_id, recorded_at);
CREATE INDEX versions_patient_time_idx ON clinical_entry_versions(patient_id, occurred_at);

CREATE TABLE follow_ups (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  due_date date NOT NULL,
  instructions text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sensitivity text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE referrals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  to_facility text NOT NULL,
  reason text NOT NULL,
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','completed','cancelled')),
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sensitivity text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE exchange_grants (
  id uuid PRIMARY KEY,
  patient_id uuid NOT NULL REFERENCES patients(id),
  grantor_user_id uuid NOT NULL REFERENCES users(id),
  recipient_tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_tenant_ids uuid[] NOT NULL CHECK (cardinality(source_tenant_ids) > 0),
  categories text[] NOT NULL CHECK (cardinality(categories) > 0),
  purpose text NOT NULL,
  legal_basis text NOT NULL CHECK (legal_basis IN ('patient-consent','continuing-care','emergency','statutory')),
  authorization_evidence text NOT NULL,
  policy_version text NOT NULL DEFAULT 'medveris-consent-1.0',
  sensitivity_exclusions text[] NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1,
  previous_grant_id uuid REFERENCES exchange_grants(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);
CREATE INDEX grants_patient_idx ON exchange_grants(patient_id, recipient_tenant_id, revoked_at, expires_at);

CREATE TABLE emergency_overrides (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','reviewed-acceptable','reviewed-escalated')),
  review_due_at timestamptz NOT NULL,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX overrides_tenant_idx ON emergency_overrides(tenant_id, review_status, created_at);

CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL,
  declared_type text NOT NULL,
  detected_type text,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL,
  object_key text NOT NULL UNIQUE,
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','quarantined','clean','rejected')),
  scan_detail text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','available','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz
);

CREATE TABLE credentials (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('practitioner','facility')),
  subject_user_id uuid REFERENCES users(id),
  subject_tenant_id uuid REFERENCES tenants(id),
  submitted_by uuid NOT NULL REFERENCES users(id),
  credential_type text NOT NULL,
  issuer text NOT NULL,
  jurisdiction text NOT NULL,
  credential_number text NOT NULL,
  scope text,
  issued_on date NOT NULL,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','quarantined','pending','verified','rejected','expired','revoked','suspended','superseded')),
  version integer NOT NULL DEFAULT 1,
  previous_credential_id uuid REFERENCES credentials(id),
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  decision_reason text,
  checks_performed text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'practitioner' AND subject_user_id IS NOT NULL) OR (subject_type = 'facility' AND subject_tenant_id IS NOT NULL))
);
CREATE INDEX credentials_queue_idx ON credentials(status, created_at);

CREATE TABLE credential_documents (
  credential_id uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES uploads(id),
  PRIMARY KEY (credential_id, upload_id)
);

CREATE TABLE access_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  tenant_id uuid REFERENCES tenants(id),
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  key text NOT NULL,
  actor_id uuid NOT NULL,
  tenant_id uuid,
  route text NOT NULL,
  request_digest text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (actor_id, key)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  actor_user_id uuid,
  actor_kind text NOT NULL,
  actor_roles text[] NOT NULL DEFAULT '{}',
  action text NOT NULL,
  purpose text,
  subject_patient_id uuid REFERENCES patients(id),
  resource_type text,
  resource_id uuid,
  decision text NOT NULL DEFAULT 'allow' CHECK (decision IN ('allow','deny')),
  reason_code text,
  grant_id uuid REFERENCES exchange_grants(id),
  override_id uuid REFERENCES emergency_overrides(id),
  correlation_id text,
  ip_address text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  previous_hash text,
  event_hash text NOT NULL,
  nonce text NOT NULL,
  signature_key_id text,
  signature text
);
CREATE INDEX audit_tenant_time_idx ON audit_events(tenant_id, occurred_at);
CREATE INDEX audit_patient_time_idx ON audit_events(subject_patient_id, occurred_at);
CREATE INDEX audit_action_time_idx ON audit_events(action, occurred_at);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  event_type text NOT NULL,
  aggregate_id uuid,
  aggregate_version integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  processed_at timestamptz,
  last_error text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','dead-letter')),
  idempotency_key text UNIQUE
);
CREATE INDEX outbox_pending_idx ON outbox_events(status, next_attempt_at);

CREATE TABLE processed_outbox_events (
  event_id uuid PRIMARY KEY REFERENCES outbox_events(id),
  processed_at timestamptz NOT NULL DEFAULT now(),
  processor text NOT NULL
);

CREATE TABLE integrity_checkpoints (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  batch_number integer NOT NULL,
  event_count integer NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  merkle_root text NOT NULL,
  previous_checkpoint_hash text,
  signature text NOT NULL,
  signature_key_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'SHA-256-MERKLE+HMAC-SHA256',
  ledger_state text NOT NULL DEFAULT 'not-requested'
    CHECK (ledger_state IN ('not-requested','pending','submitted','confirmed','failed','verification-failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, batch_number)
);

CREATE TABLE ledger_anchors (
  id uuid PRIMARY KEY,
  checkpoint_id uuid NOT NULL REFERENCES integrity_checkpoints(id),
  adapter text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','submitted','confirmed','failed','verification-failed')),
  transaction_ref text,
  network text,
  confirmation_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE TABLE integration_configs (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  adapter text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  configured_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, adapter)
);

-- Immutability guards.
CREATE OR REPLACE FUNCTION app.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'clinical_entry_versions'
     AND OLD.status = 'draft' AND NEW.status = 'signed'
     AND OLD.content_digest = NEW.content_digest
     AND OLD.entry_id = NEW.entry_id
     AND OLD.version = NEW.version
     AND OLD.author_id = NEW.author_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'immutable_audit_or_version_row' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();
CREATE TRIGGER clinical_versions_immutable BEFORE UPDATE OR DELETE ON clinical_entry_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();
CREATE TRIGGER checkpoints_immutable BEFORE UPDATE OR DELETE ON integrity_checkpoints
FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_mutation();

-- Row level security.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant ON memberships USING (tenant_id = app.current_tenant() OR user_id = app.current_user())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON invitations USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY patients_staff_read ON patients FOR SELECT USING (app.actor_kind() = 'staff' AND app.current_user() IS NOT NULL);
CREATE POLICY patients_self_read ON patients FOR SELECT USING (id = app.current_patient());
CREATE POLICY patients_registration_write ON patients FOR INSERT WITH CHECK (app.actor_kind() IN ('registration','staff'));
CREATE POLICY patients_staff_update ON patients FOR UPDATE USING (app.actor_kind() = 'staff') WITH CHECK (app.actor_kind() = 'staff');

ALTER TABLE patient_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY patient_accounts_self ON patient_accounts USING (user_id = app.current_user() OR patient_id = app.current_patient());
CREATE POLICY patient_accounts_staff ON patient_accounts FOR SELECT USING (app.actor_kind() = 'staff');
CREATE POLICY patient_accounts_insert ON patient_accounts FOR INSERT WITH CHECK (app.actor_kind() IN ('registration','staff') OR user_id = app.current_user());

ALTER TABLE patient_duplicate_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_duplicate_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY duplicates_staff ON patient_duplicate_candidates USING (app.actor_kind() = 'staff') WITH CHECK (app.actor_kind() = 'staff');

ALTER TABLE tenant_patient_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_patient_links FORCE ROW LEVEL SECURITY;
CREATE POLICY links_tenant ON tenant_patient_links USING (tenant_id = app.current_tenant() OR patient_id = app.current_patient())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_tenant ON appointments USING (tenant_id = app.current_tenant() OR patient_id = app.current_patient())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE queues ENABLE ROW LEVEL SECURITY;
ALTER TABLE queues FORCE ROW LEVEL SECURITY;
CREATE POLICY queues_tenant ON queues USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY queue_entries_tenant ON queue_entries USING (tenant_id = app.current_tenant()) WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE encounters FORCE ROW LEVEL SECURITY;
CREATE POLICY encounters_tenant ON encounters USING (
  (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff') OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff');

ALTER TABLE triage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY triage_tenant ON triage_records USING (
  (tenant_id = app.current_tenant() AND (app.has_any_role(ARRAY['clinician','nurse']) OR app.actor_kind() = 'staff'))
  OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE observations FORCE ROW LEVEL SECURITY;
CREATE POLICY observations_tenant ON observations USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE conditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conditions FORCE ROW LEVEL SECURITY;
CREATE POLICY conditions_tenant ON conditions USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE allergies ENABLE ROW LEVEL SECURITY;
ALTER TABLE allergies FORCE ROW LEVEL SECURITY;
CREATE POLICY allergies_tenant ON allergies USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE clinical_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY entries_tenant ON clinical_entries USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE clinical_entry_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_entry_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY versions_tenant ON clinical_entry_versions USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']))
  OR (patient_id = app.current_patient() AND status IN ('signed','amended','entered-in-error'))
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_ups FORCE ROW LEVEL SECURITY;
CREATE POLICY followups_tenant ON follow_ups USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals FORCE ROW LEVEL SECURITY;
CREATE POLICY referrals_tenant ON referrals USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

ALTER TABLE exchange_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE exchange_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY grants_patient ON exchange_grants USING (
  patient_id = app.current_patient() OR recipient_tenant_id = app.current_tenant()
) WITH CHECK (patient_id = app.current_patient() AND grantor_user_id = app.current_user());
CREATE POLICY grants_patient_update ON exchange_grants FOR UPDATE USING (patient_id = app.current_patient())
  WITH CHECK (patient_id = app.current_patient());

ALTER TABLE emergency_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_overrides FORCE ROW LEVEL SECURITY;
CREATE POLICY overrides_tenant ON emergency_overrides USING (
  (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff') OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.actor_kind() = 'staff');

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY uploads_tenant ON uploads USING (tenant_id = app.current_tenant() OR app.is_platform_reviewer())
  WITH CHECK (tenant_id = app.current_tenant());

ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_tenant ON credentials USING (
  (subject_tenant_id = app.current_tenant() OR subject_user_id = app.current_user() OR submitted_by = app.current_user())
  OR app.is_platform_reviewer()
) WITH CHECK (subject_tenant_id = app.current_tenant() OR subject_user_id = app.current_user());
CREATE POLICY credentials_reviewer_update ON credentials FOR UPDATE USING (app.is_platform_reviewer())
  WITH CHECK (app.is_platform_reviewer());

ALTER TABLE credential_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_docs ON credential_documents USING (
  EXISTS (SELECT 1 FROM credentials c WHERE c.id = credential_id) OR app.is_platform_reviewer()
) WITH CHECK (EXISTS (SELECT 1 FROM credentials c WHERE c.id = credential_id));

ALTER TABLE access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tokens_self ON access_tokens USING (user_id = app.current_user()) WITH CHECK (user_id = app.current_user());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idem_tenant ON idempotency_keys USING (actor_id = app.current_user() OR tenant_id = app.current_tenant())
  WITH CHECK (actor_id = app.current_user() OR tenant_id = app.current_tenant());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (app.current_user() IS NOT NULL OR app.actor_kind() IN ('registration','system'));
CREATE POLICY audit_read_governance ON audit_events FOR SELECT USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['facility_admin','auditor'])
);
CREATE POLICY audit_read_patient ON audit_events FOR SELECT USING (subject_patient_id = app.current_patient());
CREATE POLICY audit_jobs_read ON audit_events FOR SELECT TO medveris_jobs USING (true);

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_insert ON outbox_events FOR INSERT WITH CHECK (tenant_id = app.current_tenant() OR app.current_user() IS NOT NULL);
CREATE POLICY outbox_jobs ON outbox_events TO medveris_jobs USING (true) WITH CHECK (true);

ALTER TABLE processed_outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY processed_jobs ON processed_outbox_events TO medveris_jobs USING (true) WITH CHECK (true);

ALTER TABLE integration_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_configs FORCE ROW LEVEL SECURITY;
CREATE POLICY integrations_tenant ON integration_configs USING (tenant_id = app.current_tenant() OR tenant_id IS NULL)
  WITH CHECK (tenant_id = app.current_tenant());

-- Narrow exchange path. The function owner can bypass RLS but only returns a grant-validated projection.
CREATE OR REPLACE FUNCTION app.exchange_project(p_grant_id uuid, p_tenant uuid, p_patient uuid)
RETURNS TABLE (
  category text,
  source_tenant_id uuid,
  source_facility text,
  resource_id uuid,
  author_id uuid,
  author_name text,
  occurred_at timestamptz,
  recorded_at timestamptz,
  status text,
  title text,
  summary text,
  payload jsonb,
  sensitivity text[]
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g exchange_grants%ROWTYPE;
BEGIN
  SELECT * INTO g FROM exchange_grants
   WHERE id = p_grant_id AND patient_id = p_patient AND recipient_tenant_id = p_tenant
     AND revoked_at IS NULL AND starts_at <= now() AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange_denied' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT 'encounter'::text, e.tenant_id, t.name, e.id, e.created_by, u.display_name,
         e.opened_at, e.created_at, e.state, 'Encounter: ' || e.type, e.reason, to_jsonb(e), ARRAY[]::text[]
    FROM encounters e JOIN tenants t ON t.id = e.tenant_id JOIN users u ON u.id = e.created_by
   WHERE e.patient_id = p_patient AND e.tenant_id = ANY(g.source_tenant_ids) AND 'encounter' = ANY(g.categories)
  UNION ALL
  SELECT 'note'::text, v.tenant_id, t.name, v.id, v.author_id, u.display_name,
         v.occurred_at, v.recorded_at, v.status, v.title,
         COALESCE(v.content->>'assessment', ''), v.content, v.sensitivity
    FROM clinical_entry_versions v
    JOIN clinical_entries ce ON ce.id = v.entry_id AND ce.current_version = v.version
    JOIN tenants t ON t.id = v.tenant_id JOIN users u ON u.id = v.author_id
   WHERE v.patient_id = p_patient AND v.tenant_id = ANY(g.source_tenant_ids)
     AND 'note' = ANY(g.categories) AND v.status IN ('signed','amended','entered-in-error')
     AND NOT (v.sensitivity && g.sensitivity_exclusions)
  UNION ALL
  SELECT 'observation'::text, o.tenant_id, t.name, o.id, o.author_id, u.display_name,
         o.occurred_at, o.recorded_at, o.status, o.display,
         o.value_num::text || ' ' || COALESCE(o.unit_code, ''), o.coding, o.sensitivity
    FROM observations o JOIN tenants t ON t.id = o.tenant_id JOIN users u ON u.id = o.author_id
   WHERE o.patient_id = p_patient AND o.tenant_id = ANY(g.source_tenant_ids)
     AND 'observation' = ANY(g.categories) AND NOT (o.sensitivity && g.sensitivity_exclusions)
  UNION ALL
  SELECT 'condition'::text, c.tenant_id, t.name, c.id, c.author_id, u.display_name,
         c.recorded_at, c.recorded_at, c.clinical_status, c.display,
         COALESCE(c.note, ''), c.coding, c.sensitivity
    FROM conditions c JOIN tenants t ON t.id = c.tenant_id JOIN users u ON u.id = c.author_id
   WHERE c.patient_id = p_patient AND c.tenant_id = ANY(g.source_tenant_ids)
     AND 'condition' = ANY(g.categories) AND NOT (c.sensitivity && g.sensitivity_exclusions)
  UNION ALL
  SELECT 'allergy'::text, a.tenant_id, t.name, a.id, a.author_id, u.display_name,
         a.recorded_at, a.recorded_at, a.state,
         CASE WHEN a.state = 'unknown' THEN 'Allergy status unknown' WHEN a.state = 'none' THEN 'No known allergies' ELSE COALESCE(a.substance_coding->>'display','Allergy recorded') END,
         COALESCE(a.note, ''), jsonb_build_object('state', a.state, 'substance', a.substance_coding, 'reaction', a.reaction_coding, 'severity', a.severity), a.sensitivity
    FROM allergies a JOIN tenants t ON t.id = a.tenant_id JOIN users u ON u.id = a.author_id
   WHERE a.patient_id = p_patient AND a.tenant_id = ANY(g.source_tenant_ids)
     AND 'allergy' = ANY(g.categories) AND NOT (a.sensitivity && g.sensitivity_exclusions)
  UNION ALL
  SELECT 'follow-up'::text, f.tenant_id, t.name, f.id, f.author_id, u.display_name,
         f.created_at, f.created_at, f.status, 'Follow-up due ' || f.due_date::text, f.instructions, to_jsonb(f), f.sensitivity
    FROM follow_ups f JOIN tenants t ON t.id = f.tenant_id JOIN users u ON u.id = f.author_id
   WHERE f.patient_id = p_patient AND f.tenant_id = ANY(g.source_tenant_ids)
     AND 'follow-up' = ANY(g.categories) AND NOT (f.sensitivity && g.sensitivity_exclusions)
  UNION ALL
  SELECT 'referral'::text, r.tenant_id, t.name, r.id, r.author_id, u.display_name,
         r.created_at, r.created_at, r.status, 'Referral to ' || r.to_facility, r.reason, to_jsonb(r), r.sensitivity
    FROM referrals r JOIN tenants t ON t.id = r.tenant_id JOIN users u ON u.id = r.author_id
   WHERE r.patient_id = p_patient AND r.tenant_id = ANY(g.source_tenant_ids)
     AND 'referral' = ANY(g.categories) AND NOT (r.sensitivity && g.sensitivity_exclusions)
  ORDER BY occurred_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION app.emergency_project(p_override_id uuid, p_tenant uuid, p_patient uuid)
RETURNS TABLE (
  category text, source_tenant_id uuid, source_facility text, resource_id uuid,
  author_id uuid, author_name text, occurred_at timestamptz, recorded_at timestamptz,
  status text, title text, summary text, payload jsonb
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o emergency_overrides%ROWTYPE;
  g exchange_grants%ROWTYPE;
BEGIN
  SELECT * INTO o FROM emergency_overrides
   WHERE id = p_override_id AND tenant_id = p_tenant AND patient_id = p_patient
     AND revoked_at IS NULL AND started_at <= now() AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'override_denied' USING ERRCODE = '42501';
  END IF;
  g.recipient_tenant_id := p_tenant;
  g.source_tenant_ids := ARRAY(SELECT id FROM tenants WHERE id <> p_tenant);
  g.categories := ARRAY['encounter','note','observation','condition','allergy','follow-up','referral'];
  g.sensitivity_exclusions := ARRAY['mental-health','reproductive-health','genetic','hiv'];
  RETURN QUERY
  SELECT 'note', v.tenant_id, t.name, v.id, v.author_id, u.display_name, v.occurred_at, v.recorded_at,
         v.status, v.title, COALESCE(v.content->>'assessment',''), v.content
    FROM clinical_entry_versions v
    JOIN clinical_entries ce ON ce.id = v.entry_id AND ce.current_version = v.version
    JOIN tenants t ON t.id = v.tenant_id JOIN users u ON u.id = v.author_id
   WHERE v.patient_id = p_patient AND v.status IN ('signed','amended')
     AND NOT (v.sensitivity && g.sensitivity_exclusions)
     AND v.tenant_id = ANY(g.source_tenant_ids);
END;
$$;

ALTER FUNCTION app.exchange_project(uuid, uuid, uuid) OWNER TO medveris_exchange;
ALTER FUNCTION app.emergency_project(uuid, uuid, uuid) OWNER TO medveris_exchange;
REVOKE ALL ON FUNCTION app.exchange_project(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.emergency_project(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.exchange_project(uuid, uuid, uuid) TO medveris_runtime;
GRANT EXECUTE ON FUNCTION app.emergency_project(uuid, uuid, uuid) TO medveris_runtime;

-- Grants. RLS still applies unless EXPLICITLY noted above.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, auth_challenges, email_tokens, tenants, memberships, platform_roles, invitations,
  patients, patient_accounts, patient_duplicate_candidates, tenant_patient_links, appointments, queues,
  queue_entries, encounters, triage_records, observations, conditions, allergies, clinical_entries,
  clinical_entry_versions, follow_ups, referrals, exchange_grants, emergency_overrides, uploads,
  credentials, credential_documents, access_tokens, idempotency_keys, audit_events, outbox_events,
  processed_outbox_events, integration_configs
TO medveris_runtime;

GRANT SELECT ON schema_migrations TO medveris_runtime;
GRANT SELECT ON integrity_checkpoints, ledger_anchors TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO medveris_jobs;
GRANT SELECT, INSERT ON processed_outbox_events TO medveris_jobs;
GRANT SELECT ON audit_events TO medveris_jobs;
GRANT SELECT ON tenants TO medveris_jobs;
GRANT SELECT, INSERT ON integrity_checkpoints TO medveris_jobs;
GRANT SELECT, INSERT ON ledger_anchors TO medveris_jobs;
GRANT SELECT ON users TO medveris_exchange;
GRANT SELECT ON tenants, patients, exchange_grants, encounters, clinical_entries, clinical_entry_versions,
  observations, conditions, allergies, follow_ups, referrals, emergency_overrides TO medveris_exchange;

REVOKE UPDATE, DELETE ON audit_events FROM medveris_runtime;
REVOKE UPDATE, DELETE ON clinical_entry_versions FROM medveris_runtime;
REVOKE UPDATE, DELETE ON integrity_checkpoints FROM medveris_runtime;
REVOKE UPDATE, DELETE ON audit_events FROM medveris_jobs;
REVOKE UPDATE, DELETE ON integrity_checkpoints FROM medveris_jobs;

COMMIT;
