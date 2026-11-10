-- Grants for reference data tables
-- Allows medveris_runtime to read global reference data

BEGIN;

GRANT SELECT ON reference_cadres TO medveris_runtime;
GRANT SELECT ON reference_job_titles TO medveris_runtime;
GRANT SELECT ON reference_specialties TO medveris_runtime;
GRANT SELECT ON reference_departments TO medveris_runtime;
GRANT SELECT ON reference_regulators TO medveris_runtime;
GRANT SELECT ON reference_capabilities TO medveris_runtime;
GRANT SELECT ON reference_payroll_grades TO medveris_runtime;

GRANT SELECT ON facility_reference_extensions TO medveris_runtime;
GRANT SELECT ON facility_payroll_grades TO medveris_runtime;
GRANT SELECT ON staff_payroll_assignments TO medveris_runtime;
GRANT SELECT ON staff_qualifications TO medveris_runtime;

GRANT REFERENCES ON reference_cadres TO medveris_runtime;
GRANT REFERENCES ON reference_job_titles TO medveris_runtime;
GRANT REFERENCES ON reference_specialties TO medveris_runtime;
GRANT REFERENCES ON reference_departments TO medveris_runtime;
GRANT REFERENCES ON reference_regulators TO medveris_runtime;
GRANT REFERENCES ON reference_capabilities TO medveris_runtime;
GRANT REFERENCES ON reference_payroll_grades TO medveris_runtime;

GRANT REFERENCES ON facility_reference_extensions TO medveris_runtime;
GRANT REFERENCES ON facility_payroll_grades TO medveris_runtime;
GRANT REFERENCES ON staff_payroll_assignments TO medveris_runtime;
GRANT REFERENCES ON staff_qualifications TO medveris_runtime;

COMMIT;
