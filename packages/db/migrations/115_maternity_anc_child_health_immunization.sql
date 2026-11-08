-- Antenatal care visits, child health events, immunisations, facility vaccine
-- schedule, and due/catch-up helper functions. Additive and backward
-- compatible: existing maternity episodes, labour observations, delivery
-- records and newborn records are untouched.
--
-- Clinical note:
--   • Vaccine schedule is facility-configured guidance only. It is seeded here
--     with a reasonable Uganda MoH-aligned routine EPI schedule for under-1s
--     but facilities and clinics should verify against the current national
--     schedule before depending on it. It is never used as a rule that blocks
--     clinical judgement.
--   • APGAR scoring, Z-score interpretation and postnatal observation content
--     are kept in the UI/app layer or as documentation; this migration does
--     not encode treatment rules or alerts that would replace professional
--     judgement.
--
-- Endpoint names below intentionally match apps/api/src/routes/maternity.ts.
-- Column naming for ANC counselling fields also matches the insert statement
-- in that route. If you backfill different names, reconcile the route SQL too.

BEGIN;

-- ---------------------------------------------------------------------------
-- antenatal_visits
-- One visit per ANC contact. The gravidity/parity/EDD/risk on the episode are
-- the summary point; this table is the visit-level ANC card content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS antenatal_visits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES maternity_episodes(id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,

  -- dating / gestational age
  gestational_age_weeks numeric CHECK (gestational_age_weeks IS NULL OR gestational_age_weeks >= 0),
  lmp_date date,
  edd date,
  dating_basis text CHECK (dating_basis IS NULL OR dating_basis IN (
    'lmp','ultrasound','clinical','unknown'
  )),

  -- risk is recorded on the episode; this column is the visit-level
  -- reassessment that may trigger an episode update via the API layer.
  risk_level text CHECK (risk_level IS NULL OR risk_level IN (
    'not-assessed','low','moderate','high'
  )),

  -- vitals / observations
  blood_pressure_systolic integer,
  blood_pressure_diastolic integer,
  pulse integer,
  temperature_c numeric,
  respiratory_rate integer,
  oxygen_saturation numeric,
  weight_kg numeric,
  height_cm numeric,
  bmi numeric,
  fundal_height_cm numeric,
  fetal_heart_rate integer,

  fetal_position text,
  fetal_lie text,
  presentation text,
  contractions_per_10_min integer,
  amniotic_fluid text,

  -- intrapartum-style fields can also be recorded on ANC context where
  -- relevant (for example when a visit coincides with a labour admission).
  cervix_dilatation_cm numeric,
  cervix_effacement_percent numeric,
  station text,

  -- labs / screening
  urine_protein text,
  urine_sugar text,
  hemoglobin_gdl numeric,
  blood_group text,
  rhesus text,
  hiv_status text,
  syphilis_status text,
  malaria_status text,

  -- preventive interventions at this visit (simple flags, not invented rules)
  received_tetanus_immunization boolean,
  received_iron_folic_acid boolean,
  received_intermittent_preventive_treatment boolean,

  -- counselling flags: names match the maternity.ts insert statement.
  birth_preparement_counselling boolean,
  danger_sign_counseling boolean,
  breastfeeding_counseling boolean,

  postnatal_plan text,
  notes text,

  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS antenatal_tenant_episode_idx
  ON antenatal_visits(tenant_id, episode_id, occurred_at);
CREATE INDEX IF NOT EXISTS antenatal_tenant_idx
  ON antenatal_visits(tenant_id, occurred_at);

-- ---------------------------------------------------------------------------
-- child_health_events
-- Longitudinal child health visit/event record. Separate patient identity:
-- linked only through the same tenant and patient id.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS child_health_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  episode_id uuid REFERENCES maternity_episodes(id) ON DELETE SET NULL,

  event_date date NOT NULL,
  event_point text,

  weight_kg numeric,
  height_cm numeric,
  head_circumference_cm numeric,

  -- Z-scores are optional. Leave them null at entry and compute at review
  -- time if the app layer wants them; this table does not force a particular
  -- WHO/UNIQUAC/WHO Anthro computation path.
  weight_for_age_z numeric,
  height_for_age_z numeric,
  weight_for_height_z numeric,

  muac_cm numeric,
  developmental_milestones jsonb,
  nutrition_status text,
  feeding_practice text,
  notes text,

  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS child_health_patient_idx
  ON child_health_events(patient_id, event_date desc, created_at desc);
CREATE INDEX IF NOT EXISTS child_health_tenant_idx
  ON child_health_events(tenant_id, event_date);

-- ---------------------------------------------------------------------------
-- immunization_schedules
-- Facility-configured guidance. Not a hard-coded national EPI table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS immunization_schedules (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vaccine_code text NOT NULL,
  vaccine_name text NOT NULL,
  total_doses integer CHECK (total_doses IS NULL OR total_doses > 0),
  recommended_at_months numeric NOT NULL CHECK (recommended_at_months >= 0),
  min_age_months numeric CHECK (min_age_months IS NULL OR min_age_months >= 0),
  dose_interval_days integer CHECK (dose_interval_days IS NULL OR dose_interval_days > 0),
  route text,
  site text,
  schedule_note text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, vaccine_code, recommended_at_months)
);

CREATE INDEX IF NOT EXISTS immunization_schedule_tenant_idx
  ON immunization_schedules(tenant_id, recommended_at_months);

-- Reasonable guidance-only seed for a typical Uganda facility. This seed
-- reflects commonly used routine EPI antigens and ages but must be verified
-- against the current national schedule before use as guidance.
INSERT INTO immunization_schedules (
  id, tenant_id, vaccine_code, vaccine_name, total_doses,
  recommended_at_months, route, site, schedule_note, created_by
)
SELECT
  gen_random_uuid(),
  t.id,
  CASE v.code
    WHEN 'BCG' THEN 'BCG'
    WHEN 'OPV0' THEN 'OPV'
    WHEN 'OPV1' THEN 'OPV'
    WHEN 'OPV2' THEN 'OPV'
    WHEN 'OPV3' THEN 'OPV'
    WHEN 'DPT1' THEN 'DPT-HepB-Hib'
    WHEN 'DPT2' THEN 'DPT-HepB-Hib'
    WHEN 'DPT3' THEN 'DPT-HepB-Hib'
    WHEN 'ROTA1' THEN 'Rotavirus'
    WHEN 'ROTA2' THEN 'Rotavirus'
    WHEN 'ROTA3' THEN 'Rotavirus'
    WHEN 'PCV1' THEN 'PCV'
    WHEN 'PCV2' THEN 'PCV'
    WHEN 'PCV3' THEN 'PCV'
    WHEN 'IPV1' THEN 'IPV'
    WHEN 'MCV1' THEN 'Measles-Rubella'
    WHEN 'MCV2' THEN 'Measles-Rubella'
    ELSE v.code
  END,
  v.name,
  v.total_doses,
  v.recommended_at_months,
  v.route,
  v.site,
  v.note,
  t.created_by_user_id
FROM tenants t
CROSS JOIN (
  VALUES
    ('BCG',      'BCG (tuberculosis)',                        1, 0.0,  'intradermal',  'right upper arm', 'Give at birth or first contact where not given at birth.'),
    ('OPV0',     'Oral polio vaccine (birth dose)',          1, 0.0,  'oral',         'mouth',          'Birth dose where used.'),
    ('OPV1',     'Oral polio vaccine',                       3, 1.5,  'oral',         'mouth',          'Routine infant schedule; intervals per facility guidance.'),
    ('OPV2',     'Oral polio vaccine',                       3, 2.5,  'oral',         'mouth',          'Routine infant schedule; intervals per facility guidance.'),
    ('OPV3',     'Oral polio vaccine',                       3, 3.5,  'oral',         'mouth',          'Routine infant schedule; intervals per facility guidance.'),
    ('DPT1',     'DPT-HepB-Hib (pentavalent)',               3, 1.5,  'intramuscular','left thigh',     'First pentavalent dose.'),
    ('DPT2',     'DPT-HepB-Hib (pentavalent)',               3, 2.5,  'intramuscular','left thigh',     'Second pentavalent dose.'),
    ('DPT3',     'DPT-HepB-Hib (pentavalent)',               3, 3.5,  'intramuscular','left thigh',     'Third pentavalent dose.'),
    ('ROTA1',    'Rotavirus',                                3, 1.5,  'oral',         'inner cheek',    'Rotavirus schedule per facility guidance; verify current product and dose count.'),
    ('ROTA2',    'Rotavirus',                                3, 2.5,  'oral',         'inner cheek',    'Rotavirus schedule per facility guidance; verify current product and dose count.'),
    ('ROTA3',    'Rotavirus',                                3, 3.5,  'oral',         'inner cheek',    'Rotavirus schedule per facility guidance; verify current product and dose count.'),
    ('PCV1',     'Pneumococcal conjugate vaccine',           3, 1.5,  'intramuscular','right thigh',    'First PCV dose.'),
    ('PCV2',     'Pneumococcal conjugate vaccine',           3, 2.5,  'intramuscular','right thigh',    'Second PCV dose.'),
    ('PCV3',     'Pneumococcal conjugate vaccine',           3, 3.5,  'intramuscular','right thigh',    'Third PCV dose.'),
    ('IPV1',     'Inactivated polio vaccine',                1, 3.5,  'intramuscular','right thigh',    'Give at 14 weeks or first contact after that age where used.'),
    ('MCV1',     'Measles-Rubella',                          2, 9.0,  'subcutaneous', 'left upper arm', 'First measles-containing dose at 9 months.'),
    ('MCV2',     'Measles-Rubella',                          2, 18.0, 'subcutaneous', 'left upper arm', 'Second measles-containing dose at 18 months where adopted.')
) AS v(code, name, total_doses, recommended_at_months, route, site, note)
WHERE t.created_by_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM immunization_schedules s WHERE s.tenant_id = t.id
  );

-- ---------------------------------------------------------------------------
-- immunizations
-- Administration / missed-dose record linked to a child patient and optionally
-- to a child_health_event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS immunizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  child_health_event_id uuid REFERENCES child_health_events(id) ON DELETE SET NULL,

  vaccine_code text,
  vaccine_name text,
  dose_number integer,
  total_doses integer,
  schedule_date date,
  administered_at timestamptz,
  route text,
  site text,
  lot_number text,
  batch_expiry_date date,
  manufacturer text,
  cold_chain_observed boolean,
  healthcare_worker_id uuid REFERENCES users(id),
  healthcare_worker_name text,
  anaphylaxis_observed boolean,
  aefi_note text,

  -- exactly one of administered_at / missed_dose_reason must be set per the
  -- API validation in maternity.ts.
  missed_dose_reason text,
  next_dose_due_date date,

  notes text,

  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT immunization_exactly_one_outcome CHECK (
    (administered_at IS NOT NULL)::integer + (missed_dose_reason IS NOT NULL)::integer = 1
  )
);

CREATE INDEX IF NOT EXISTS immunization_patient_idx
  ON immunizations(patient_id, administered_at nulls last, created_at desc);
CREATE INDEX IF NOT EXISTS immunization_tenant_idx
  ON immunizations(tenant_id, patient_id);

-- ---------------------------------------------------------------------------
-- RLS for the new maternity/child-health tables.
-- Policy pattern mirrors 011: clinician/nurse access for maternity chart data,
-- plus patient self-access where a patient id is present.
-- ---------------------------------------------------------------------------
ALTER TABLE antenatal_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE antenatal_visits FORCE ROW LEVEL SECURITY;
ALTER TABLE child_health_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE child_health_events FORCE ROW LEVEL SECURITY;
ALTER TABLE immunization_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE immunization_schedules FORCE ROW LEVEL SECURITY;
ALTER TABLE immunizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE immunizations FORCE ROW LEVEL SECURITY;

CREATE POLICY antenatal_visit_access ON antenatal_visits
  USING (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']))
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY child_health_event_access ON child_health_events
  USING (
    (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']))
    OR patient_id = app.current_patient()
  )
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY immunization_schedule_access ON immunization_schedules
  USING (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']))
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

CREATE POLICY immunization_access ON immunizations
  USING (
    (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']))
    OR patient_id = app.current_patient()
  )
  WITH CHECK (tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse']));

-- ---------------------------------------------------------------------------
-- Due / catch-up helper functions.
-- Names must match apps/api/src/routes/maternity.ts exactly. The endpoint SQL
-- in that file intentionally uses immunication_due_for_patient and
-- immunication_catch_up_for_patient; those spellings are kept here so the
-- existing routes do not need a rename at this stage.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION immunication_due_for_patient(patient_id uuid)
RETURNS TABLE (
  vaccine_code text,
  vaccine_name text,
  recommended_at_months numeric,
  due_date date,
  dose_number integer,
  latest_administered_at timestamptz,
  latest_administered_id uuid,
  latest_missed_reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    s.vaccine_code,
    s.vaccine_name,
    s.recommended_at_months,
    -- due date derived from patient date of birth + schedule guidance
    (p.date_of_birth + (s.recommended_at_months * interval '1 month'))::date AS due_date,
    d.dose_number,
    a.administered_at,
    a.id,
    NULL::text
  FROM immunization_schedules s
  JOIN patients p ON p.id = patient_id
  CROSS JOIN LATERAL (
    SELECT generate_series(1, coalesce(s.total_doses, 1)) AS dose_number
  ) d
  LEFT JOIN LATERAL (
    SELECT i.administered_at, i.id, i.missed_dose_reason
    FROM immunizations i
    WHERE i.tenant_id = p.created_tenant_id
      AND i.patient_id = patient_id
      AND i.vaccine_code = s.vaccine_code
      AND i.dose_number = d.dose_number
      AND i.administered_at IS NOT NULL
    ORDER BY i.administered_at DESC
    LIMIT 1
  ) a ON true
  WHERE s.tenant_id = p.created_tenant_id
    AND a.administered_at IS NULL
  ORDER BY s.recommended_at_months, d.dose_number;
$$;

CREATE OR REPLACE FUNCTION immunication_catch_up_for_patient(
  patient_id uuid,
  from_date date,
  max_age_months integer DEFAULT NULL
)
RETURNS TABLE (
  vaccine_code text,
  vaccine_name text,
  recommended_at_months numeric,
  due_date date,
  dose_number integer,
  latest_administered_at timestamptz,
  latest_administered_id uuid,
  latest_missed_reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT
    s.vaccine_code,
    s.vaccine_name,
    s.recommended_at_months,
    (p.date_of_birth + (s.recommended_at_months * interval '1 month'))::date AS due_date,
    d.dose_number,
    a.administered_at,
    a.id,
    NULL::text
  FROM immunization_schedules s
  JOIN patients p ON p.id = patient_id
  CROSS JOIN LATERAL (
    SELECT generate_series(1, coalesce(s.total_doses, 1)) AS dose_number
  ) d
  LEFT JOIN LATERAL (
    SELECT i.administered_at, i.id, i.missed_dose_reason
    FROM immunizations i
    WHERE i.tenant_id = p.created_tenant_id
      AND i.patient_id = patient_id
      AND i.vaccine_code = s.vaccine_code
      AND i.dose_number = d.dose_number
      AND i.administered_at IS NOT NULL
    ORDER BY i.administered_at DESC
    LIMIT 1
  ) a ON true
  WHERE s.tenant_id = p.created_tenant_id
    AND (
      -- catch-up candidate: scheduled dose not yet administered.
      a.administered_at IS NULL
      -- or already administered, but came after the canonical due date window
      -- so the record can still be reviewed as catch-up if the caller wants it.
      OR (a.administered_at IS NOT NULL AND (a.administered_at)::date > (p.date_of_birth + (s.recommended_at_months * interval '1 month'))::date)
    )
    AND (max_age_months IS NULL OR (p.date_of_birth + (s.recommended_at_months * interval '1 month'))::date <= (p.date_of_birth + (max_age_months * interval '1 month'))::date)
    AND (from_date IS NULL OR (p.date_of_birth + (s.recommended_at_months * interval '1 month'))::date >= from_date)
  ORDER BY s.recommended_at_months, d.dose_number;
$$;

-- ---------------------------------------------------------------------------
-- Grants for the runtime role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON antenatal_visits TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON child_health_events TO medveris_runtime;
GRANT SELECT ON immunization_schedules TO medveris_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON immunizations TO medveris_runtime;

GRANT EXECUTE ON FUNCTION immunication_due_for_patient(uuid) TO medveris_runtime;
GRANT EXECUTE ON FUNCTION immunication_catch_up_for_patient(uuid, date, integer) TO medveris_runtime;

COMMIT;
