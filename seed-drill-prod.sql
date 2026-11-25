-- Minimal synthetic seed for pgBackRest restore drill (test data only, not real patient data)
-- Breaks FK cycles: organizations -> tenants -> users -> patients (all FKs nullable)

insert into organizations (id, name, legal_name, registration_ref, country, status, kind)
values ('0a000000-0000-4000-8000-000000000001', 'Medveris Synthetic Health Group', 'Medveris Synthetic Health Group Ltd', 'SYNTH-ORG-001', 'Uganda', 'active', 'facility-group')
on conflict (id) do nothing;

insert into tenants (id, name, slug, facility_type, city, country, email, phone, status, public_listing, organization_id)
values
  ('11111111-1111-4111-8111-111111111111', 'Kampala Community Clinic (synthetic)', 'kampala-general', 'outpatient', 'Kampala', 'Uganda', 'hello@kampala.example', '+256-000-000-001', 'active', true, '0a000000-0000-4000-8000-000000000001'),
  ('22222222-2222-4222-8222-222222222222', 'Entebbe Family Health Centre (synthetic)', 'entebbe-family', 'outpatient', 'Entebbe', 'Uganda', 'hello@entebbe.example', '+256-000-000-002', 'active', true, '0a000000-0000-4000-8000-000000000001')
on conflict (id) do nothing;

insert into users (id, email, email_verified_at, password_hash, display_name, given_name, family_name, status, recovery_codes)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin@medveris.local', now(), '\\$2b\\$10\\$dummyhashforsyntheticseeddata0000000000000', 'Amina Administrator', 'Amina', 'Administrator', 'active', '[]'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'clinician@medveris.local', now(), '\\$2b\\$10\\$dummyhashforsyntheticseeddata0000000000001', 'Dr Daniel Okello', 'Daniel', 'Okello', 'active', '[]'::jsonb),
  ('99999999-9999-4999-8999-999999999999', 'patient@medveris.local', now(), '\\$2b\\$10\\$dummyhashforsyntheticseeddata0000000000002', 'Amina Nakato', 'Amina', 'Nakato', 'active', '[]'::jsonb)
on conflict (id) do nothing;

insert into patients (id, public_id, given_name, family_name, date_of_birth, sex, email, phone, identity_confidence, created_via, created_tenant_id)
values
  ('a0000000-0000-4000-8000-000000000001', 'MV-7K2M-9QX4-4T2A-8Z3N', 'Amina', 'Nakato', '1988-04-12', 'female', 'patient@medveris.local', '+256-700-000-001', 'confirmed-verbal', 'assisted-registration', '11111111-1111-4111-8111-111111111111'),
  ('a0000000-0000-4000-8000-000000000002', 'MV-9Q4T-6H2J-8K5M-3P7S', 'Joseph', 'Mukasa', '1974-11-03', 'male', 'joseph@example.test', '+256-700-000-002', 'confirmed-verbal', 'assisted-registration', '11111111-1111-4111-8111-111111111111'),
  ('a0000000-0000-4000-8000-000000000003', 'MV-3N8P-2W7R-5Y6C-1B4D', 'Grace', 'Achieng', '1996-07-21', 'female', 'grace@example.test', '+256-700-000-003', 'confirmed-verbal', 'assisted-registration', '11111111-1111-4111-8111-111111111111'),
  ('b0000000-0000-4000-8000-000000000001', 'MV-5V8X-2C4B-7N9M-6Q1W', 'Brian', 'Ochieng', '1982-02-17', 'male', 'brian@example.test', '+256-700-000-004', 'confirmed-verbal', 'assisted-registration', '22222222-2222-4222-8222-222222222222')
on conflict (id) do nothing;

select 'seed' as step, (select count(*) from tenants) as tenants, (select count(*) from users) as users, (select count(*) from patients) as patients, (select count(*) from organizations) as organizations;
