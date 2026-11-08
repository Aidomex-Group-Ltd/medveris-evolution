BEGIN;

-- Reporting obligations are jurisdiction-specific. Record the jurisdiction on the rule and on every
-- approved dataset mapping so a template is always tied to a named authority context, not only to
-- the free-text source citation. Uganda is the built-in default for the MoH eHMIS programme; other
-- jurisdictions declare their own rows explicitly.
ALTER TABLE hmis_reporting_rules ADD COLUMN jurisdiction text NOT NULL DEFAULT 'Uganda' CHECK (length(jurisdiction) BETWEEN 2 AND 80);
ALTER TABLE hmis_dataset_mappings ADD COLUMN jurisdiction text NOT NULL DEFAULT 'Uganda' CHECK (length(jurisdiction) BETWEEN 2 AND 80);

COMMENT ON COLUMN hmis_reporting_rules.jurisdiction IS 'Jurisdiction the reporting obligation applies to.';
COMMENT ON COLUMN hmis_dataset_mappings.jurisdiction IS 'Jurisdiction the approved mapping applies to.';

COMMIT;
