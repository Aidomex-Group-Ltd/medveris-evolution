-- Ward readiness, nursing workflow, maternity time-series charting, mortuary
-- custody, housekeeping and portering. Clinical discharge never marks a bed
-- clean by itself. Mortuary case identifiers are independent of patient IDs.

BEGIN;

ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_status_check;
ALTER TABLE beds ADD CONSTRAINT beds_status_check CHECK (status IN (
  'available','occupied','vacated','awaiting-cleaning','cleaning-in-progress',
  'cleaning','ready','out-of-service','unavailable'
));

CREATE TABLE bed_readiness_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bed_id uuid NOT NULL REFERENCES beds(id) ON DELETE CASCADE,
  from_status text NOT NULL,
  to_status text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  cleaning_task_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bed_readiness_bed_idx ON bed_readiness_events(bed_id, created_at);

ALTER TABLE nursing_tasks
  ADD COLUMN assigned_to_user_id uuid REFERENCES users(id),
  ADD COLUMN task_type text NOT NULL DEFAULT 'general',
  ADD COLUMN omitted_reason text,
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN escalated_to_user_id uuid REFERENCES users(id);

ALTER TABLE nursing_assessments
  ADD COLUMN risk_assessments jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN escalation text;

CREATE TABLE fluid_balance_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  occurred_at timestamptz NOT NULL,
  intake_ml numeric CHECK (intake_ml IS NULL OR intake_ml >= 0),
  output_ml numeric CHECK (output_ml IS NULL OR output_ml >= 0),
  source text NOT NULL CHECK (source IN ('oral','intravenous','urine','drain','vomit','stool','other')),
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (intake_ml IS NOT NULL OR output_ml IS NOT NULL)
);
CREATE INDEX fluid_balance_admission_idx ON fluid_balance_entries(admission_id, occurred_at);

ALTER TABLE medication_administrations DROP CONSTRAINT IF EXISTS medication_administrations_status_check;
ALTER TABLE medication_administrations ADD CONSTRAINT medication_administrations_status_check
  CHECK (status IN ('administered','refused','held','omitted'));
ALTER TABLE medication_administrations
  ADD COLUMN reason text,
  ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX medication_admin_idempotency ON medication_administrations(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE maternity_episodes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  gravidity integer CHECK (gravidity IS NULL OR gravidity >= 0),
  parity integer CHECK (parity IS NULL OR parity >= 0),
  estimated_due_date date,
  dating_basis text CHECK (dating_basis IS NULL OR dating_basis IN (
    'lmp','ultrasound','clinical','unknown'
  )),
  risk_level text NOT NULL DEFAULT 'not-assessed' CHECK (risk_level IN (
    'not-assessed','low','moderate','high'
  )),
  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active','delivered','closed','transferred-out','cancelled'
  )),
  admitted_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX maternity_tenant_status_idx ON maternity_episodes(tenant_id, status, created_at);
CREATE INDEX maternity_patient_idx ON maternity_episodes(patient_id, created_at);

CREATE TABLE labour_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES maternity_episodes(id) ON DELETE CASCADE,
  template_type text NOT NULL CHECK (template_type IN ('labour-care-guide','partograph')),
  clinical_occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  maternal jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetal jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  late_entry boolean NOT NULL DEFAULT false,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX labour_episode_time_idx ON labour_observations(episode_id, clinical_occurred_at);

CREATE TABLE delivery_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL UNIQUE REFERENCES maternity_episodes(id),
  delivered_at timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('spontaneous-vaginal','assisted-vaginal','caesarean','other')),
  outcome text NOT NULL CHECK (outcome IN ('live-birth','stillbirth','multiple','other')),
  blood_loss_ml numeric CHECK (blood_loss_ml IS NULL OR blood_loss_ml >= 0),
  perineum text,
  complications text,
  notes text,
  attended_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE newborn_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES maternity_episodes(id) ON DELETE CASCADE,
  patient_id uuid REFERENCES patients(id),
  given_name text NOT NULL DEFAULT 'Baby',
  family_name text NOT NULL,
  sex text NOT NULL DEFAULT 'unknown' CHECK (sex IN ('female','male','other','unknown')),
  born_at timestamptz,
  weight_g integer CHECK (weight_g IS NULL OR weight_g > 0),
  apgar_1 integer CHECK (apgar_1 IS NULL OR apgar_1 BETWEEN 0 AND 10),
  apgar_5 integer CHECK (apgar_5 IS NULL OR apgar_5 BETWEEN 0 AND 10),
  feeding text,
  status text NOT NULL DEFAULT 'observed' CHECK (status IN (
    'observed','admitted','transferred','discharged','deceased'
  )),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (patient_id IS NULL OR patient_id IS DISTINCT FROM episode_id)
);
CREATE INDEX newborn_episode_idx ON newborn_records(episode_id, created_at);

CREATE TABLE cleaning_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bed_id uuid REFERENCES beds(id) ON DELETE SET NULL,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  zone text NOT NULL,
  task_type text NOT NULL CHECK (task_type IN (
    'routine','terminal','discharge','isolation','spill','inspection','other'
  )),
  risk_level text NOT NULL DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN (
    'assigned','in-progress','completed','verified','cancelled'
  )),
  assigned_to_user_id uuid REFERENCES users(id),
  instructions text,
  started_at timestamptz,
  completed_at timestamptz,
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('assigned','in-progress','cancelled') OR completed_at IS NOT NULL),
  CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX cleaning_tenant_status_idx ON cleaning_tasks(tenant_id, status, created_at);

CREATE TABLE porter_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN (
    'patient-transfer','specimen','equipment','document','other'
  )),
  patient_id uuid REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  from_location text NOT NULL,
  to_location text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested','accepted','in-progress','completed','cancelled'
  )),
  assigned_to_user_id uuid REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  identity_checked boolean NOT NULL DEFAULT false,
  specimen_custody boolean NOT NULL DEFAULT false,
  pickup_at timestamptz,
  delivered_at timestamptz,
  delay_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (request_type <> 'specimen' OR specimen_custody = true)
);
CREATE INDEX porter_tenant_status_idx ON porter_tasks(tenant_id, status, created_at);

CREATE TABLE mortuary_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_ref text NOT NULL,
  patient_id uuid REFERENCES patients(id),
  deceased_name text NOT NULL,
  identity_status text NOT NULL DEFAULT 'unknown' CHECK (identity_status IN (
    'unknown','provisional','verified'
  )),
  received_at timestamptz NOT NULL DEFAULT now(),
  received_from text NOT NULL,
  storage_location text NOT NULL,
  status text NOT NULL DEFAULT 'in-custody' CHECK (status IN (
    'in-custody','released','transferred','closed'
  )),
  death_confirmed_at timestamptz,
  death_document_ref text,
  cause_document_ref text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, case_ref)
);
CREATE INDEX mortuary_tenant_status_idx ON mortuary_cases(tenant_id, status, received_at);

CREATE TABLE mortuary_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES mortuary_cases(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN (
    'receipt','internal-transfer','post-mortem','release','return','other'
  )),
  from_location text,
  to_location text NOT NULL,
  identity_checked boolean NOT NULL,
  verified_by uuid NOT NULL REFERENCES users(id),
  witnessed_by text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mortuary_movements_case_idx ON mortuary_movements(case_id, occurred_at);

CREATE TABLE mortuary_effects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES mortuary_cases(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  custody_status text NOT NULL DEFAULT 'held' CHECK (custody_status IN (
    'held','returned','disposed'
  )),
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mortuary_releases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL UNIQUE REFERENCES mortuary_cases(id),
  released_to_name text NOT NULL,
  relationship text NOT NULL,
  authority_reference text NOT NULL,
  identification_method text NOT NULL,
  identity_verified_by uuid NOT NULL REFERENCES users(id),
  handover_witness text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engineering_assets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_ref text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'in-service' CHECK (status IN (
    'in-service','maintenance','out-of-service','retired'
  )),
  next_maintenance_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, asset_ref)
);

CREATE TABLE maintenance_work_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES engineering_assets(id),
  fault text NOT NULL,
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open','assigned','in-progress','completed','verified','cancelled'
  )),
  assigned_to_user_id uuid REFERENCES users(id),
  completed_at timestamptz,
  release_note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cssd_cycles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sterilizer text NOT NULL,
  cycle_ref text NOT NULL,
  load_count integer NOT NULL DEFAULT 0 CHECK (load_count >= 0),
  indicator_result text NOT NULL CHECK (indicator_result IN ('pass','fail','pending')),
  status text NOT NULL DEFAULT 'quarantined' CHECK (status IN (
    'quarantined','released','recalled','discarded'
  )),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cycle_ref),
  CHECK (status <> 'released' OR (indicator_result = 'pass' AND released_by IS NOT NULL))
);

ALTER TABLE bed_readiness_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bed_readiness_events FORCE ROW LEVEL SECURITY;
ALTER TABLE fluid_balance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE fluid_balance_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE maternity_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE maternity_episodes FORCE ROW LEVEL SECURITY;
ALTER TABLE labour_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE labour_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_records FORCE ROW LEVEL SECURITY;
ALTER TABLE newborn_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE newborn_records FORCE ROW LEVEL SECURITY;
ALTER TABLE cleaning_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE cleaning_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE porter_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE porter_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE mortuary_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mortuary_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE mortuary_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE mortuary_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE mortuary_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE mortuary_effects FORCE ROW LEVEL SECURITY;
ALTER TABLE mortuary_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE mortuary_releases FORCE ROW LEVEL SECURITY;
ALTER TABLE engineering_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE engineering_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_work_orders FORCE ROW LEVEL SECURITY;
ALTER TABLE cssd_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE cssd_cycles FORCE ROW LEVEL SECURITY;

CREATE POLICY bed_readiness_access ON bed_readiness_events USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin','housekeeping','porter'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin','housekeeping'])
);
CREATE POLICY fluid_balance_access ON fluid_balance_entries USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY maternity_episode_access ON maternity_episodes USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY labour_observations_access ON labour_observations USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY delivery_records_access ON delivery_records USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY newborn_records_access ON newborn_records USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY cleaning_access ON cleaning_tasks USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['housekeeping','facility_admin','clinician','nurse','porter'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['housekeeping','facility_admin','nurse'])
);
CREATE POLICY porter_access ON porter_tasks USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['porter','facility_admin','clinician','nurse'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['porter','facility_admin','nurse','clinician'])
);
CREATE POLICY mortuary_cases_access ON mortuary_cases USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin']));
CREATE POLICY mortuary_movements_access ON mortuary_movements USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin']));
CREATE POLICY mortuary_effects_access ON mortuary_effects USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin']));
CREATE POLICY mortuary_releases_access ON mortuary_releases USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['mortuary','facility_admin']));
CREATE POLICY engineering_assets_access ON engineering_assets USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['biomedical','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['biomedical','facility_admin']));
CREATE POLICY maintenance_access ON maintenance_work_orders USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['biomedical','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['biomedical','facility_admin']));
CREATE POLICY cssd_access ON cssd_cycles USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['cssd','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['cssd','facility_admin']));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  bed_readiness_events, fluid_balance_entries, maternity_episodes, labour_observations,
  delivery_records, newborn_records, cleaning_tasks, porter_tasks, mortuary_cases,
  mortuary_movements, mortuary_effects, mortuary_releases, engineering_assets,
  maintenance_work_orders, cssd_cycles
TO medveris_runtime;
REVOKE UPDATE, DELETE ON labour_observations FROM medveris_runtime;
REVOKE UPDATE, DELETE ON mortuary_movements FROM medveris_runtime;
REVOKE UPDATE, DELETE ON mortuary_releases FROM medveris_runtime;

COMMIT;
