-- Grant INSERT on professional_designations to medveris_runtime so that
-- recordProfessionalDesignation can write signed clinician designations.
-- RLS policies (050_professional_designations.sql) already cover tenant isolation
-- and system-access checks; this grant provides the underlying table permission.
--

BEGIN;

GRANT INSERT ON professional_designations TO medveris_runtime;

COMMIT;