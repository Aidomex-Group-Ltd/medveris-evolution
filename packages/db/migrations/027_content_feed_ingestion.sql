-- Automatic import of public content from official feeds and public APIs.
--
-- Imported items are published immediately, carry imported_at, their source and a link back,
-- and are never marked clinically reviewed. Only the scheduled jobs role (medveris_jobs)
-- inserts them, as the non-login importer account; it cannot update or delete content.
-- Platform operators withdraw imported items and pause sources. Additive only.

BEGIN;

INSERT INTO users (id, email, password_hash, display_name, given_name, family_name, status)
VALUES ('00000000-0000-4000-8000-00000000feed', 'content-importer@system.medveris.invalid', '!no-login',
        'Medveris content importer', 'Content', 'Importer', 'closed')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE content_sources
  ADD COLUMN ingest_adapter text CHECK (ingest_adapter IN ('rss', 'who-don', 'grants-gov')),
  ADD COLUMN ingest_url text CHECK (ingest_url IS NULL OR ingest_url ~ '^https://'),
  ADD COLUMN ingest_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN ingest_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN fetch_interval_minutes integer NOT NULL DEFAULT 360 CHECK (fetch_interval_minutes BETWEEN 15 AND 10080),
  ADD COLUMN last_success_at timestamptz,
  ADD COLUMN last_item_count integer,
  ADD CONSTRAINT content_sources_ingest_ready CHECK (NOT ingest_enabled OR (ingest_adapter IS NOT NULL AND ingest_url IS NOT NULL));

ALTER TABLE content_items
  ADD COLUMN external_id text,
  ADD COLUMN imported_at timestamptz;

ALTER TABLE opportunities
  ADD COLUMN source_id uuid REFERENCES content_sources(id),
  ADD COLUMN external_id text,
  ADD COLUMN imported_at timestamptz;

-- Replace the unnamed type and publication checks so imported rows can be published without
-- an editorial reviewer. Lookup by definition keeps this independent of generated names.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE contype = 'c' AND (
       (conrelid = 'content_items'::regclass AND (
          pg_get_constraintdef(oid) LIKE '%reviewer_user_id IS NOT NULL%'
          OR pg_get_constraintdef(oid) LIKE '%facility-announcement%'))
       OR (conrelid = 'opportunities'::regclass AND (
          pg_get_constraintdef(oid) LIKE '%reviewed_at IS NOT NULL%'
          OR pg_get_constraintdef(oid) LIKE '%study-participation%')))
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',
      CASE WHEN constraint_name LIKE 'opportunities%' THEN 'opportunities' ELSE 'content_items' END, constraint_name);
  END LOOP;
END $$;

ALTER TABLE content_items
  ADD CONSTRAINT content_items_content_type_check CHECK (content_type IN (
    'public-health-advisory','health-education','research-update','guideline',
    'professional-learning','facility-announcement','health-news'
  )),
  ADD CONSTRAINT content_items_published_reviewed CHECK (
    status <> 'published' OR (reviewed_at IS NOT NULL AND reviewer_user_id IS NOT NULL) OR imported_at IS NOT NULL
  ),
  ADD CONSTRAINT content_items_import_provenance CHECK (
    imported_at IS NULL OR (source_id IS NOT NULL AND external_id IS NOT NULL AND source_url IS NOT NULL
                            AND tenant_id IS NULL AND NOT clinical_reviewed)
  );

ALTER TABLE opportunities
  ADD CONSTRAINT opportunities_opportunity_type_check CHECK (opportunity_type IN (
    'employment','locum','cpd','conference','fellowship','training','research-collaboration',
    'community-screening','health-education','patient-support','study-participation','funding'
  )),
  ADD CONSTRAINT opportunities_published_reviewed CHECK (
    moderation_state <> 'published' OR reviewed_at IS NOT NULL OR imported_at IS NOT NULL
  ),
  ADD CONSTRAINT opportunities_import_provenance CHECK (
    imported_at IS NULL OR (source_id IS NOT NULL AND external_id IS NOT NULL AND application_url IS NOT NULL
                            AND tenant_id IS NULL AND verification_status = 'unverified')
  );

CREATE UNIQUE INDEX content_items_external ON content_items(source_id, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX opportunities_external ON opportunities(source_id, external_id) WHERE external_id IS NOT NULL;

-- Scheduled importer ---------------------------------------------------------
GRANT SELECT, UPDATE ON content_sources TO medveris_jobs;
GRANT SELECT, INSERT ON content_items, opportunities TO medveris_jobs;

CREATE POLICY content_sources_jobs ON content_sources FOR ALL TO medveris_jobs
  USING (tenant_id IS NULL AND ingest_adapter IS NOT NULL)
  WITH CHECK (tenant_id IS NULL AND ingest_adapter IS NOT NULL);
CREATE POLICY content_items_jobs_read ON content_items FOR SELECT TO medveris_jobs USING (imported_at IS NOT NULL);
CREATE POLICY content_items_jobs_insert ON content_items FOR INSERT TO medveris_jobs WITH CHECK (
  tenant_id IS NULL AND imported_at IS NOT NULL AND author_user_id = '00000000-0000-4000-8000-00000000feed'
);
CREATE POLICY opportunities_jobs_read ON opportunities FOR SELECT TO medveris_jobs USING (imported_at IS NOT NULL);
CREATE POLICY opportunities_jobs_insert ON opportunities FOR INSERT TO medveris_jobs WITH CHECK (
  tenant_id IS NULL AND imported_at IS NOT NULL AND author_user_id = '00000000-0000-4000-8000-00000000feed'
);

-- Platform operators withdraw imported items and pause sources ----------------
CREATE POLICY content_sources_platform_update ON content_sources FOR UPDATE
  USING (tenant_id IS NULL AND app.is_platform_operator())
  WITH CHECK (tenant_id IS NULL AND app.is_platform_operator());
CREATE POLICY content_items_platform_imported_read ON content_items FOR SELECT
  USING (imported_at IS NOT NULL AND app.is_platform_operator());
CREATE POLICY content_items_platform_imported_update ON content_items FOR UPDATE
  USING (imported_at IS NOT NULL AND app.is_platform_operator())
  WITH CHECK (imported_at IS NOT NULL AND app.is_platform_operator());
CREATE POLICY opportunities_platform_imported_read ON opportunities FOR SELECT
  USING (imported_at IS NOT NULL AND app.is_platform_operator());
CREATE POLICY opportunities_platform_imported_update ON opportunities FOR UPDATE
  USING (imported_at IS NOT NULL AND app.is_platform_operator())
  WITH CHECK (imported_at IS NOT NULL AND app.is_platform_operator());

-- Official sources ------------------------------------------------------------
-- Platform-wide sources are writable only by a platform content editor (content_sources_write).
SELECT set_config('app.platform_role', 'content_editor', true);
INSERT INTO content_sources (id, tenant_id, name, source_kind, base_url, rss_url, status, terms_note,
  ingest_adapter, ingest_url, ingest_enabled, ingest_config)
VALUES
  ('c0f1ed00-0000-4000-8000-000000000001', NULL, 'World Health Organization: news', 'public-health-authority',
   'https://www.who.int', 'https://www.who.int/rss-feeds/news-english.xml', 'configured',
   'WHO website content (c) World Health Organization. Medveris stores the headline, a short excerpt and a link to the original.',
   'rss', 'https://www.who.int/rss-feeds/news-english.xml', true,
   '{"contentType":"health-news","maxItems":15,"maxAgeDays":90,"priority":40}'),
  ('c0f1ed00-0000-4000-8000-000000000002', NULL, 'World Health Organization: Disease Outbreak News', 'public-health-authority',
   'https://www.who.int/emergencies/disease-outbreak-news', NULL, 'configured',
   'WHO Disease Outbreak News (c) World Health Organization. Medveris stores the title, a short excerpt and a link to the original.',
   'who-don', 'https://www.who.int/api/news/diseaseoutbreaknews', true,
   '{"contentType":"public-health-advisory","maxItems":10,"maxAgeDays":180,"priority":60}'),
  ('c0f1ed00-0000-4000-8000-000000000003', NULL, 'WHO Regional Office for Africa: news', 'public-health-authority',
   'https://www.afro.who.int', 'https://www.afro.who.int/rss/featured-news.xml', 'configured',
   'WHO AFRO website content (c) World Health Organization. Medveris stores the headline, a short excerpt and a link to the original.',
   'rss', 'https://www.afro.who.int/rss/featured-news.xml', true,
   '{"contentType":"health-news","maxItems":15,"maxAgeDays":90,"priority":45,"geography":"Africa"}'),
  ('c0f1ed00-0000-4000-8000-000000000004', NULL, 'Uganda National Institute of Public Health', 'government',
   'https://uniph.go.ug', 'https://uniph.go.ug/feed/', 'configured',
   'Government of Uganda public health institute. Medveris stores the headline, a short excerpt and a link to the original.',
   'rss', 'https://uniph.go.ug/feed/', true,
   '{"contentType":"health-news","maxItems":15,"maxAgeDays":180,"priority":45,"geography":"Uganda"}'),
  ('c0f1ed00-0000-4000-8000-000000000005', NULL, 'Grants.gov: health fellowships', 'opportunity-board',
   'https://www.grants.gov', NULL, 'configured',
   'U.S. federal funding listings (public domain). Eligibility is set by each funder; many are limited to U.S. organisations.',
   'grants-gov', 'https://api.grants.gov/v1/api/search2', true,
   '{"keyword":"fellowship","fundingCategories":"HL","maxItems":15}'),
  ('c0f1ed00-0000-4000-8000-000000000006', NULL, 'Grants.gov: global health funding and training', 'opportunity-board',
   'https://www.grants.gov', NULL, 'configured',
   'U.S. federal funding listings (public domain). Eligibility is set by each funder; many are limited to U.S. organisations.',
   'grants-gov', 'https://api.grants.gov/v1/api/search2', true,
   '{"keyword":"global health","fundingCategories":"HL","maxItems":15}')
ON CONFLICT (id) DO NOTHING;

COMMIT;
