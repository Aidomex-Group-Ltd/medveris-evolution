-- Versioned legal documents and append-only acceptance records.
--
-- A document version is immutable: a material change is a new row/version, never an edit. An
-- acceptance points at the exact document id, version and digest that the person saw, so a later
-- version can never rewrite what was previously accepted. Marketing, cookie and clinical consent
-- remain separate records elsewhere; this table records platform Terms/Privacy acknowledgement only.

BEGIN;

CREATE TABLE legal_documents (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('terms', 'privacy')),
  version text NOT NULL CHECK (version ~ '^[0-9]+(\.[0-9]+){1,3}$'),
  title text NOT NULL,
  effective_at timestamptz NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  review_status text NOT NULL CHECK (review_status IN ('counsel-review-required', 'counsel-reviewed')),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (kind, version)
);

CREATE UNIQUE INDEX legal_documents_one_published
  ON legal_documents(kind) WHERE status = 'published';

CREATE TABLE legal_acceptances (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  tenant_id uuid REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES legal_documents(id),
  policy_kind text NOT NULL CHECK (policy_kind IN ('terms', 'privacy')),
  policy_version text NOT NULL,
  policy_digest text NOT NULL CHECK (policy_digest ~ '^[0-9a-f]{64}$'),
  context text NOT NULL CHECK (context IN ('registration', 're-acceptance', 'invitation')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent_digest text,
  UNIQUE (user_id, document_id)
);

CREATE INDEX legal_acceptances_user_idx ON legal_acceptances(user_id, accepted_at DESC);
CREATE INDEX legal_acceptances_tenant_idx ON legal_acceptances(tenant_id) WHERE tenant_id IS NOT NULL;

-- Digests are release artifacts generated from apps/api/src/legal/documents.ts. The legal documents
-- unit test fails if the bundled content no longer matches these rows.
INSERT INTO legal_documents (id, kind, version, title, effective_at, content_digest, review_status, status, published_at)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'terms', '1.0', 'Medveris Terms of Service',
    '2026-11-08T00:00:00.000Z', '88593799cfad7f368c59c7f966577918ea008894fe438a7bed5820ee860f3594',
    'counsel-review-required', 'published', now()),
  ('a1000000-0000-4000-8000-000000000002', 'privacy', '1.0', 'Medveris Privacy Notice',
    '2026-11-08T00:00:00.000Z', '619f08eb8ad889c8cb8165c2d2e4f74c10bb30f1a5820ccf9c025d0d6f254c04',
    'counsel-review-required', 'published', now());

ALTER TABLE legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptances FORCE ROW LEVEL SECURITY;

-- Anyone, including an unauthenticated visitor, may read the published legal metadata. The document
-- body is bundled with the release; this row is the version/digest reference.
CREATE POLICY legal_documents_public_read ON legal_documents FOR SELECT
  USING (status = 'published');

CREATE POLICY legal_documents_operator_read ON legal_documents FOR SELECT
  USING (app.is_platform_operator());

CREATE POLICY legal_documents_operator_write ON legal_documents FOR INSERT
  WITH CHECK (app.is_platform_operator() OR app.actor_kind() = 'system');

CREATE POLICY legal_documents_operator_update ON legal_documents FOR UPDATE
  USING (app.is_platform_operator() OR app.actor_kind() = 'system')
  WITH CHECK (app.is_platform_operator() OR app.actor_kind() = 'system');

-- A person sees their own acceptance history; platform operators may inspect it for an audit.
CREATE POLICY legal_acceptances_read ON legal_acceptances FOR SELECT
  USING (user_id = app.current_user() OR app.is_platform_operator());

-- Registration writes run before a session exists, so the trusted registration/system actor may
-- append the acknowledgement. Updates and deletes are not granted: the record is immutable.
CREATE POLICY legal_acceptances_append ON legal_acceptances FOR INSERT
  WITH CHECK (user_id = app.current_user() OR app.actor_kind() IN ('registration', 'system'));

GRANT SELECT ON legal_documents TO medveris_runtime, medveris_exchange;
GRANT SELECT, INSERT ON legal_acceptances TO medveris_runtime;
GRANT SELECT ON legal_acceptances TO medveris_exchange;

COMMENT ON TABLE legal_acceptances IS
  'Append-only platform Terms acceptance and Privacy Notice acknowledgement. Never overwrite an accepted version; publish a new document version instead.';

COMMIT;
