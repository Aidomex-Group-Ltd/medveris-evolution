-- BMI screening persisted on encounter note drafting and maternity labour-partograph alerting.
-- BMI is computed in the clinical route where height/weight are observable in the note text; this table
-- records the result for the encounter so it is visible on the record rather than only logged.
-- Labour alerts are decision support only: manual alerts are recorded by staff, and partograph-generated
-- alerts are surfaced through the clinical route from the labour observation data.

BEGIN;

CREATE TABLE clinical_bmi_screenings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL REFERENCES patients(id),
  encounter_id uuid REFERENCES encounters(id),
  entry_id uuid REFERENCES clinical_entries(id),
  bmi numeric NOT NULL CHECK (bmi >= 0),
  risk_level text NOT NULL CHECK (risk_level IN ('low','moderate','high')),
  weight_kg numeric CHECK (weight_kg IS NULL OR weight_kg >= 0),
  height_m numeric CHECK (height_m IS NULL OR height_m > 0),
  computed_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE labour_alerts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES maternity_episodes(id) ON DELETE CASCADE,
  alert text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  source text NOT NULL CHECK (source IN ('manual','partograph')),
  recorded_by uuid NOT NULL REFERENCES users(id),
  note text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clinical_bmi_screenings_encounter_idx ON clinical_bmi_screenings(tenant_id, encounter_id, recorded_at);
CREATE INDEX clinical_bmi_screenings_patient_idx ON clinical_bmi_screenings(tenant_id, patient_id, recorded_at);

CREATE INDEX labour_alerts_episode_idx ON labour_alerts(tenant_id, episode_id, recorded_at);

ALTER TABLE clinical_bmi_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_bmi_screenings FORCE ROW LEVEL SECURITY;

ALTER TABLE labour_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE labour_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_bmi_screenings_access ON clinical_bmi_screenings USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','clinical_staff'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','clinical_staff'])
);

CREATE POLICY labour_alerts_access ON labour_alerts USING (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','midwife','clinical_staff'])
) WITH CHECK (
  tenant_id = app.current_tenant() AND app.has_any_role(ARRAY['clinician','nurse','midwife','clinical_staff'])
);

GRANT SELECT, INSERT, UPDATE, DELETE ON clinical_bmi_screenings, labour_alerts TO medveris_runtime;

COMMIT;
