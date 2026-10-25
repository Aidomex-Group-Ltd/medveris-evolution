-- M2/M3 clinical operations: inpatient, emergency, theatre, diagnostics,
-- pharmacy, finance, programmes, public health, telehealth and device/AI
-- adapters. Every table is tenant scoped and RLS forced.

BEGIN;

ALTER TABLE encounters DROP CONSTRAINT IF EXISTS encounters_type_check;
ALTER TABLE encounters ADD CONSTRAINT encounters_type_check
  CHECK (type IN ('walk-in','scheduled','follow-up','emergency','inpatient','theatre','telehealth'));

CREATE TABLE wards (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  ward_type text NOT NULL CHECK (ward_type IN ('general','adult-male','adult-female','pediatric','surgical','maternity','nicu','icu')),
  description text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE beds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ward_id uuid NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  label text NOT NULL,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','occupied','cleaning','unavailable')),
  status_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ward_id, label)
);

CREATE TABLE admissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  ward_type text NOT NULL CHECK (ward_type IN ('general','adult-male','adult-female','pediatric','surgical','maternity','nicu','icu')),
  attending_user_id uuid REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','discharged','transferred-out','deceased','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  discharged_at timestamptz,
  summary text,
  disposition_reason text,
  admitted_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admissions_tenant_status_idx ON admissions(tenant_id, status, admitted_at);
CREATE INDEX admissions_patient_idx ON admissions(patient_id, admitted_at);

CREATE TABLE bed_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id),
  bed_id uuid NOT NULL REFERENCES beds(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text
);
CREATE UNIQUE INDEX bed_assignments_active_bed ON bed_assignments(bed_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX bed_assignments_active_admission ON bed_assignments(admission_id) WHERE released_at IS NULL;

CREATE TABLE bed_transfers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id),
  from_bed_id uuid REFERENCES beds(id),
  to_bed_id uuid NOT NULL REFERENCES beds(id),
  reason text NOT NULL,
  transferred_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nursing_assessments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  shift text NOT NULL CHECK (shift IN ('day','evening','night')),
  notes text NOT NULL,
  pain_score integer CHECK (pain_score BETWEEN 0 AND 10),
  mobility text,
  skin text,
  nurse_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nursing_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  description text NOT NULL,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE nursing_handoffs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  admission_id uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid NOT NULL REFERENCES users(id),
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE theatres (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','maintenance','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE theatre_cases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  admission_id uuid REFERENCES admissions(id),
  procedure_name text NOT NULL,
  procedure_coding jsonb,
  laterality text NOT NULL DEFAULT 'not-applicable' CHECK (laterality IN ('left','right','bilateral','not-applicable')),
  site text,
  urgency text NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','urgent','emergency')),
  scheduled_at timestamptz NOT NULL,
  theatre_id uuid REFERENCES theatres(id),
  surgeon_user_id uuid REFERENCES users(id),
  anesthetist_user_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','preop-ready','in-theatre','recovery','completed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cancellation_reason text,
  emergency_exception_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'cancelled' OR cancellation_reason IS NOT NULL)
);
CREATE INDEX theatre_cases_schedule_idx ON theatre_cases(tenant_id, scheduled_at, status);

CREATE TABLE preop_assessments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  investigations_reviewed boolean NOT NULL,
  fitness text NOT NULL,
  notes text,
  assessor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE theatre_consents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  procedure_consent boolean NOT NULL,
  site_marked boolean NOT NULL,
  consent_reference text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE theatre_checklists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('sign-in','time-out','sign-out')),
  items jsonb NOT NULL,
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (case_id, stage)
);

CREATE TABLE anesthesia_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  anesthesia_type text NOT NULL,
  notes text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE TABLE recovery_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  respiratory text NOT NULL,
  circulation text NOT NULL,
  consciousness text NOT NULL,
  pain text NOT NULL,
  notes text,
  occurred_at timestamptz NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE theatre_counts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  expected_count integer NOT NULL CHECK (expected_count >= 0),
  actual_count integer NOT NULL CHECK (actual_count >= 0),
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE theatre_specimens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES theatre_cases(id) ON DELETE CASCADE,
  specimen_type text NOT NULL,
  destination text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lab_tests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  loinc_system text NOT NULL DEFAULT 'http://loinc.org',
  loinc_version text NOT NULL,
  loinc_code text NOT NULL,
  specimen_type text NOT NULL,
  method text,
  unit_code text NOT NULL,
  mapped_reviewed boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, loinc_code)
);

CREATE TABLE service_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  order_type text NOT NULL CHECK (order_type IN ('laboratory','imaging','other')),
  priority text NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','urgent','emergency')),
  clinical_note text NOT NULL,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','collected','in-progress','resulted','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ordered_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_orders_tenant_status_idx ON service_orders(tenant_id, status, created_at);

CREATE TABLE service_order_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  lab_test_id uuid REFERENCES lab_tests(id),
  name text NOT NULL,
  specimen_type text,
  status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','collected','in-progress','resulted','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE specimens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES service_order_items(id),
  specimen_type text NOT NULL,
  collected_at timestamptz,
  received_at timestamptz,
  status text NOT NULL DEFAULT 'collected' CHECK (status IN ('collected','received','rejected')),
  rejection_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lab_results (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES service_order_items(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  value_num numeric,
  value_text text,
  unit_code text,
  reference_range text,
  interpretation text NOT NULL DEFAULT 'indeterminate' CHECK (interpretation IN ('normal','abnormal','critical','indeterminate')),
  critical boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'preliminary' CHECK (status IN ('preliminary','final')),
  authored_by uuid NOT NULL REFERENCES users(id),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'preliminary' OR verified_by IS NOT NULL)
);

CREATE TABLE lab_result_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL,
  change_reason text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (result_id, version)
);

CREATE TABLE critical_communications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES lab_results(id),
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  method text NOT NULL CHECK (method IN ('phone','in-person','secure-message')),
  notes text,
  communicated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE imaging_studies (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES service_order_items(id),
  modality text NOT NULL,
  body_site text NOT NULL,
  study_instance_uid text,
  accession text,
  pacs_state text NOT NULL DEFAULT 'not-configured' CHECK (pacs_state IN ('not-configured','pending','reconciled','quarantined')),
  reconciliation_note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE diagnostic_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES service_order_items(id),
  study_id uuid REFERENCES imaging_studies(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  findings text NOT NULL,
  impression text NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'preliminary' CHECK (status IN ('preliminary','final')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  authored_by uuid NOT NULL REFERENCES users(id),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'preliminary' OR verified_by IS NOT NULL)
);

CREATE TABLE diagnostic_report_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES diagnostic_reports(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL,
  change_reason text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, version)
);

CREATE TABLE medicines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  strength text NOT NULL,
  form text NOT NULL,
  route text NOT NULL,
  code_system text,
  code_version text,
  code text,
  knowledge_source text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE medication_orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  medicine_id uuid NOT NULL REFERENCES medicines(id),
  dose_text text NOT NULL,
  route text NOT NULL,
  frequency text NOT NULL,
  duration_days integer CHECK (duration_days BETWEEN 1 AND 365),
  status text NOT NULL DEFAULT 'pending-review' CHECK (status IN ('pending-review','approved','rejected','active','completed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ordered_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX medication_orders_tenant_status_idx ON medication_orders(tenant_id, status, created_at);

CREATE TABLE medication_order_reviews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES medication_orders(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  note text NOT NULL,
  pharmacist_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_lots (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id),
  lot_number text NOT NULL,
  expires_on date NOT NULL,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  location text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, medicine_id, lot_number)
);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  delta numeric NOT NULL,
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispenses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES medication_orders(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  quantity numeric NOT NULL CHECK (quantity > 0),
  notes text,
  dispensed_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE medication_administrations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES medication_orders(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  dose_text text NOT NULL,
  administered_at timestamptz NOT NULL,
  site text,
  notes text,
  status text NOT NULL CHECK (status IN ('administered','refused','held')),
  witnessed_by uuid REFERENCES users(id),
  administered_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE service_catalog (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('consultation','procedure','laboratory','imaging','pharmacy','bed','other')),
  price numeric NOT NULL CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'UGX' CHECK (length(currency) = 3),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  number text NOT NULL,
  currency text NOT NULL DEFAULT 'UGX' CHECK (length(currency) = 3),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','part-paid','void')),
  notes text,
  issued_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id uuid REFERENCES service_catalog(id),
  description text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  amount numeric NOT NULL CHECK (amount >= 0)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount numeric NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','bank-transfer','mobile-money','manual')),
  reference text,
  notes text,
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversed_by uuid REFERENCES users(id),
  reversal_reason text
);

CREATE TABLE claims (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  insurer text NOT NULL,
  cover_amount numeric NOT NULL CHECK (cover_amount > 0),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','submitted','accepted','rejected')),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programmes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  programme_type text NOT NULL CHECK (programme_type IN ('primary-care','preventive','immunization','chronic','maternal','hospice','palliative','community')),
  description text,
  condition_coding jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programme_enrolments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  programme_id uuid NOT NULL REFERENCES programmes(id),
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','withdrawn')),
  enrolled_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, patient_id, programme_id)
);

CREATE TABLE care_plans (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  enrolment_id uuid NOT NULL REFERENCES programme_enrolments(id),
  goals jsonb NOT NULL,
  interventions text NOT NULL,
  review_due date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  authored_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE care_plan_versions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  care_plan_id uuid NOT NULL REFERENCES care_plans(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  content jsonb NOT NULL,
  change_note text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (care_plan_id, version)
);

CREATE TABLE programme_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  programme_id uuid NOT NULL REFERENCES programmes(id),
  enrolment_id uuid NOT NULL REFERENCES programme_enrolments(id),
  event_type text NOT NULL CHECK (event_type IN ('immunization','screening','community-referral','home-visit','symptom','review')),
  details text NOT NULL,
  occurred_at timestamptz NOT NULL,
  coding jsonb,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE advance_care_documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  document_type text NOT NULL CHECK (document_type IN ('advance-directive','treatment-preference','resuscitation-preference','other')),
  content text NOT NULL,
  witnessed_by text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public_health_reports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  programme_id uuid REFERENCES programmes(id),
  title text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  condition_system text,
  condition_code text,
  age_min integer,
  age_max integer,
  case_definition_version text NOT NULL,
  min_cell integer NOT NULL DEFAULT 5 CHECK (min_cell >= 2),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','rejected','released')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  aggregate jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text,
  released_to text,
  released_at timestamptz,
  release_purpose text,
  CHECK (period_end >= period_start)
);

CREATE TABLE public_health_disclosures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES public_health_reports(id),
  recipient text NOT NULL,
  purpose text NOT NULL,
  note text,
  disclosed_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telehealth_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  clinician_user_id uuid NOT NULL REFERENCES users(id),
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','consented','in-progress','completed','failed','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  connection_status text CHECK (connection_status IN ('completed','failed')),
  notes text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz
);

CREATE TABLE telehealth_consents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES telehealth_sessions(id) ON DELETE CASCADE,
  consent boolean NOT NULL,
  notes text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  serial text NOT NULL,
  manufacturer text NOT NULL,
  model text NOT NULL,
  firmware text,
  site text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','quarantined','retired')),
  last_seen_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, serial)
);

CREATE TABLE device_metric_capabilities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  native_code text NOT NULL,
  loinc_system text NOT NULL DEFAULT 'http://loinc.org',
  loinc_version text NOT NULL,
  loinc_code text NOT NULL,
  display text NOT NULL,
  unit_code text NOT NULL,
  UNIQUE (device_id, native_code)
);

CREATE TABLE device_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  assigned_by uuid NOT NULL REFERENCES users(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE UNIQUE INDEX device_assignments_active ON device_assignments(device_id) WHERE released_at IS NULL;

CREATE TABLE device_observations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id),
  assignment_id uuid NOT NULL REFERENCES device_assignments(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid NOT NULL REFERENCES encounters(id),
  event_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  native_code text NOT NULL,
  loinc_system text NOT NULL,
  loinc_version text NOT NULL,
  loinc_code text NOT NULL,
  display text NOT NULL,
  value_num numeric NOT NULL,
  unit_code text NOT NULL,
  measured_at timestamptz NOT NULL,
  quality text NOT NULL CHECK (quality IN ('valid','questionable','invalid')),
  observation_id uuid NOT NULL REFERENCES observations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, device_id, event_id)
);

CREATE TABLE device_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_observation_id uuid NOT NULL REFERENCES device_observations(id),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','closed')),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  acknowledgement_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  task_type text NOT NULL CHECK (task_type IN ('record-summary','diagnostic-support','prediction','radiology-assist','image-analysis')),
  evidence_entry_ids uuid[] NOT NULL DEFAULT '{}',
  study_id uuid REFERENCES imaging_studies(id),
  provider text NOT NULL,
  model text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','withdrawn')),
  request_digest text NOT NULL,
  response_summary text,
  disclaimer text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Append-only history guards.
CREATE OR REPLACE FUNCTION app.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable_history_row' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER lab_result_versions_immutable BEFORE UPDATE OR DELETE ON lab_result_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();
CREATE TRIGGER diagnostic_report_versions_immutable BEFORE UPDATE OR DELETE ON diagnostic_report_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();
CREATE TRIGGER care_plan_versions_immutable BEFORE UPDATE OR DELETE ON care_plan_versions
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();
CREATE TRIGGER public_health_disclosures_immutable BEFORE UPDATE OR DELETE ON public_health_disclosures
FOR EACH ROW EXECUTE FUNCTION app.reject_append_only_mutation();

-- Row level security. Operational writes require the relevant department role;
-- read access remains tenant scoped for staff, with patient self-service on
-- longitudinal records where explicitly marked.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'wards','beds','admissions','bed_assignments','bed_transfers','nursing_assessments',
    'nursing_tasks','nursing_handoffs','theatres','theatre_cases','preop_assessments',
    'theatre_consents','theatre_checklists','anesthesia_records','recovery_observations',
    'theatre_counts','theatre_specimens','lab_tests','service_orders','service_order_items',
    'specimens','lab_results','lab_result_versions','critical_communications','imaging_studies',
    'diagnostic_reports','diagnostic_report_versions','medicines','medication_orders',
    'medication_order_reviews','stock_lots','stock_movements','dispenses',
    'medication_administrations','service_catalog','invoices','invoice_items','payments','claims',
    'programmes','programme_enrolments','care_plans','care_plan_versions','programme_events',
    'advance_care_documents','public_health_reports','public_health_disclosures',
    'telehealth_sessions','telehealth_consents','devices','device_metric_capabilities',
    'device_assignments','device_observations','device_alerts','ai_jobs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY wards_tenant ON wards USING (tenant_id = app.current_tenant()) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
);
CREATE POLICY beds_tenant ON beds USING (tenant_id = app.current_tenant()) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
);
CREATE POLICY admissions_tenant ON admissions USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY bed_assignments_tenant ON bed_assignments USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY bed_transfers_tenant ON bed_transfers USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY nursing_assessments_tenant ON nursing_assessments USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY nursing_tasks_tenant ON nursing_tasks USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY nursing_handoffs_tenant ON nursing_handoffs USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY theatres_tenant ON theatres USING (tenant_id = app.current_tenant()) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
);
CREATE POLICY theatre_cases_tenant ON theatre_cases USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY preop_tenant ON preop_assessments USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY theatre_consents_tenant ON theatre_consents USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY theatre_checklists_tenant ON theatre_checklists USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY anesthesia_tenant ON anesthesia_records USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY recovery_tenant ON recovery_observations USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY theatre_counts_tenant ON theatre_counts USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY theatre_specimens_tenant ON theatre_specimens USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY lab_tests_tenant ON lab_tests USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory','radiology','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['laboratory','facility_admin']));
CREATE POLICY service_orders_tenant ON service_orders USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory','radiology'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory','radiology']));
CREATE POLICY service_order_items_tenant ON service_order_items USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory','radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory','radiology']));
CREATE POLICY specimens_tenant ON specimens USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory']));
CREATE POLICY lab_results_tenant ON lab_results USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory']));
CREATE POLICY lab_result_versions_tenant ON lab_result_versions USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory']));
CREATE POLICY critical_comms_tenant ON critical_communications USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','laboratory']));
CREATE POLICY imaging_studies_tenant ON imaging_studies USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology','laboratory'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology']));
CREATE POLICY diagnostic_reports_tenant ON diagnostic_reports USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology']));
CREATE POLICY diagnostic_report_versions_tenant ON diagnostic_report_versions USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','radiology']));

CREATE POLICY medicines_tenant ON medicines USING (tenant_id = app.current_tenant()) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist','facility_admin'])
);
CREATE POLICY medication_orders_tenant ON medication_orders USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist']));
CREATE POLICY medication_reviews_tenant ON medication_order_reviews USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['pharmacist']));
CREATE POLICY stock_lots_tenant ON stock_lots USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['pharmacist']));
CREATE POLICY stock_movements_tenant ON stock_movements USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['pharmacist']));
CREATE POLICY dispenses_tenant ON dispenses USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['pharmacist']));
CREATE POLICY med_admin_tenant ON medication_administrations USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','pharmacist'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY catalog_tenant ON service_catalog USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY invoices_tenant ON invoices USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY invoice_items_tenant ON invoice_items USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY payments_tenant ON payments USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));
CREATE POLICY claims_tenant ON claims USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['finance','facility_admin']));

CREATE POLICY programmes_tenant ON programmes USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin']));
CREATE POLICY enrolments_tenant ON programme_enrolments USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY care_plans_tenant ON care_plans USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY care_plan_versions_tenant ON care_plan_versions USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY programme_events_tenant ON programme_events USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY advance_care_tenant ON advance_care_documents USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','public_health'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY public_health_reports_tenant ON public_health_reports USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['public_health','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['public_health','facility_admin']));
CREATE POLICY public_health_disclosures_tenant ON public_health_disclosures USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['public_health','facility_admin','auditor'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['public_health','facility_admin']));

CREATE POLICY telehealth_sessions_tenant ON telehealth_sessions USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY telehealth_consents_tenant ON telehealth_consents USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY devices_tenant ON devices USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin']));
CREATE POLICY device_caps_tenant ON device_metric_capabilities USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin']));
CREATE POLICY device_assignments_tenant ON device_assignments USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY device_observations_tenant ON device_observations USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));
CREATE POLICY device_alerts_tenant ON device_alerts USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin'])
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','facility_admin']));
CREATE POLICY ai_jobs_tenant ON ai_jobs USING (
  (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','facility_admin','auditor'])) OR patient_id = app.current_patient()
) WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician']));

GRANT SELECT, INSERT, UPDATE, DELETE ON
  wards, beds, admissions, bed_assignments, bed_transfers, nursing_assessments,
  nursing_tasks, nursing_handoffs, theatres, theatre_cases, preop_assessments,
  theatre_consents, theatre_checklists, anesthesia_records, recovery_observations,
  theatre_counts, theatre_specimens, lab_tests, service_orders, service_order_items,
  specimens, lab_results, lab_result_versions, critical_communications, imaging_studies,
  diagnostic_reports, diagnostic_report_versions, medicines, medication_orders,
  medication_order_reviews, stock_lots, stock_movements, dispenses,
  medication_administrations, service_catalog, invoices, invoice_items, payments, claims,
  programmes, programme_enrolments, care_plans, care_plan_versions, programme_events,
  advance_care_documents, public_health_reports, public_health_disclosures,
  telehealth_sessions, telehealth_consents, devices, device_metric_capabilities,
  device_assignments, device_observations, device_alerts, ai_jobs
TO medveris_runtime;

REVOKE UPDATE, DELETE ON lab_result_versions FROM medveris_runtime;
REVOKE UPDATE, DELETE ON diagnostic_report_versions FROM medveris_runtime;
REVOKE UPDATE, DELETE ON care_plan_versions FROM medveris_runtime;
REVOKE UPDATE, DELETE ON public_health_disclosures FROM medveris_runtime;

COMMIT;
