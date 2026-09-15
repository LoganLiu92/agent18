-- Pin tool semantics, provider version, transport and input/output schemas across queued runs and retries.
ALTER TABLE core.runs ADD COLUMN registry_hash text NOT NULL DEFAULT '';
UPDATE core.runs SET registry_hash='02bc567c99faa6fc4e13fea1f6e8ac72d64bf0498114035f86cf6275959a1c23' WHERE tool_id='knowledge.search' AND tool_version=1;
