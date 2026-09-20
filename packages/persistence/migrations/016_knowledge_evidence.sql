SET ROLE agent18_owner;
-- A snapshot describes the fixed input of one build, not a production deployment.
CREATE TABLE knowledge.source_snapshots (
 id uuid PRIMARY KEY, source_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 source_revision text NOT NULL, snapshot_key text, fingerprint text, observed_at timestamptz,
 generation jsonb NOT NULL, provenance_state text NOT NULL CHECK(provenance_state IN ('recorded','legacy')),
 UNIQUE(id,organization_id,project_id),
 FOREIGN KEY(id,source_id,organization_id,project_id) REFERENCES knowledge.builds(id,source_id,organization_id,project_id)
);
ALTER TABLE knowledge.articles ADD CONSTRAINT knowledge_article_build_scope UNIQUE(id,build_id,organization_id,project_id);
CREATE TABLE knowledge.source_evidence (
 id uuid PRIMARY KEY, snapshot_id uuid NOT NULL, article_id uuid NOT NULL, ordinal int NOT NULL,
 organization_id uuid NOT NULL, project_id uuid NOT NULL,
 path text NOT NULL, start_line int NOT NULL CHECK(start_line>0), end_line int NOT NULL CHECK(end_line>=start_line),
 content_hash text, provenance_state text NOT NULL CHECK(provenance_state IN ('recorded','legacy')),
 UNIQUE(article_id,ordinal), UNIQUE(id,organization_id,project_id),
 FOREIGN KEY(snapshot_id,organization_id,project_id) REFERENCES knowledge.source_snapshots(id,organization_id,project_id),
 FOREIGN KEY(article_id,snapshot_id,organization_id,project_id) REFERENCES knowledge.articles(id,build_id,organization_id,project_id)
);
CREATE INDEX source_evidence_snapshot ON knowledge.source_evidence(snapshot_id,article_id,ordinal);
CREATE TABLE knowledge.topic_evidence (
 topic_id uuid NOT NULL, evidence_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('context','supports','contradicts')),
 note text NOT NULL, confirmed boolean NOT NULL DEFAULT false,
 linked_by uuid NOT NULL REFERENCES control.operator_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(topic_id,evidence_id),
 FOREIGN KEY(topic_id,organization_id,project_id) REFERENCES knowledge.topics(id,organization_id,project_id),
 FOREIGN KEY(evidence_id,organization_id,project_id) REFERENCES knowledge.source_evidence(id,organization_id,project_id)
);
CREATE INDEX topic_evidence_reference ON knowledge.topic_evidence(evidence_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['source_snapshots','source_evidence','topic_evidence'] LOOP
  EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY operator_read ON knowledge.%I FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,''read''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['source_snapshots','source_evidence'] LOOP
  EXECUTE format('CREATE POLICY indexer_read ON knowledge.%I FOR SELECT TO agent18_indexer USING(organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE POLICY indexer_insert ON knowledge.%I FOR INSERT TO agent18_indexer WITH CHECK(organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY operator_insert ON knowledge.topic_evidence FOR INSERT TO agent18_app
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
CREATE POLICY operator_delete ON knowledge.topic_evidence FOR DELETE TO agent18_app
 USING(control.operator_knowledge_access(organization_id,project_id,'edit'));
GRANT SELECT ON knowledge.source_snapshots,knowledge.source_evidence,knowledge.topic_evidence TO agent18_app;
GRANT SELECT,INSERT ON knowledge.source_snapshots,knowledge.source_evidence TO agent18_indexer;
GRANT INSERT,DELETE ON knowledge.topic_evidence TO agent18_app;

-- Invoker rights: the indexer must already hold the project scope; no security-definer bypass.
CREATE FUNCTION knowledge.capture_build_evidence(build uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; a record; r jsonb; n int; first_line int; last_line int; observed timestamptz;
BEGIN
 SELECT * INTO b FROM knowledge.builds WHERE id=build AND state='ready' AND mode IN ('extractive','model');
 IF NOT FOUND THEN RETURN; END IF;
 BEGIN
  -- Do not substitute the migration time for an unknown observation time.
  observed := CASE WHEN b.report#>>'{provenance,snapshot,observedAt}' ~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$'
    THEN (b.report#>>'{provenance,snapshot,observedAt}')::timestamptz ELSE NULL END;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN observed := NULL;
 END;
 INSERT INTO knowledge.source_snapshots(id,source_id,organization_id,project_id,source_revision,snapshot_key,fingerprint,observed_at,generation,provenance_state)
 VALUES(b.id,b.source_id,b.organization_id,b.project_id,b.revision,
   b.report#>>'{provenance,snapshot,id}',b.report#>>'{provenance,snapshot,fingerprint}',observed,
   CASE WHEN jsonb_typeof(b.report#>'{provenance,generation}')='object' THEN b.report#>'{provenance,generation}' ELSE '{}'::jsonb END,
   CASE WHEN observed IS NOT NULL AND b.report#>>'{provenance,source,id}'=b.source_id::text THEN 'recorded' ELSE 'legacy' END)
 ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN; END IF; -- A completed capture is immutable; retries do not append evidence.
 FOR a IN SELECT * FROM knowledge.articles WHERE build_id=b.id LOOP
  n := 0;
  FOR r IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.refs)='array' THEN a.refs ELSE '[]'::jsonb END) LOOP
   n := n+1;
   IF jsonb_typeof(r->'path') IS DISTINCT FROM 'string' OR length(r->>'path') NOT BETWEEN 1 AND 2048
      OR coalesce(r->>'startLine','') !~ '^[1-9][0-9]{0,8}$' OR coalesce(r->>'endLine','') !~ '^[1-9][0-9]{0,8}$' THEN CONTINUE; END IF;
   first_line := (r->>'startLine')::int; last_line := (r->>'endLine')::int;
   IF last_line<first_line OR (r ? 'sourceId' AND r->>'sourceId' IS DISTINCT FROM b.source_id::text)
     OR (r ? 'revision' AND r->>'revision' IS DISTINCT FROM b.revision)
     OR (r ? 'snapshotId' AND r->>'snapshotId' IS DISTINCT FROM b.report#>>'{provenance,snapshot,id}') THEN CONTINUE; END IF;
   INSERT INTO knowledge.source_evidence(id,snapshot_id,article_id,ordinal,organization_id,project_id,path,start_line,end_line,content_hash,provenance_state)
   VALUES(gen_random_uuid(),b.id,a.id,n,b.organization_id,b.project_id,r->>'path',first_line,last_line,
     CASE WHEN r->>'contentHash' ~ '^[a-f0-9]{64}$' THEN r->>'contentHash' ELSE NULL END,
     CASE WHEN r->>'contentHash' ~ '^[a-f0-9]{64}$' AND r->>'sourceId'=b.source_id::text AND observed IS NOT NULL THEN 'recorded' ELSE 'legacy' END)
   ON CONFLICT DO NOTHING;
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION knowledge.capture_build_evidence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION knowledge.capture_build_evidence(uuid) TO agent18_indexer;
CREATE FUNCTION knowledge.capture_ready_build() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='ready' AND NEW.mode IN ('extractive','model') THEN PERFORM knowledge.capture_build_evidence(NEW.id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION knowledge.capture_ready_build() FROM PUBLIC;
CREATE TRIGGER capture_knowledge_evidence AFTER INSERT OR UPDATE OF state ON knowledge.builds
 FOR EACH ROW EXECUTE FUNCTION knowledge.capture_ready_build();
RESET ROLE;
-- Migration credentials backfill existing ready builds inside this migration transaction.
-- Existing source/build/article IDs, publication pointers and customer visibility are untouched.
SELECT knowledge.capture_build_evidence(id) FROM knowledge.builds WHERE state='ready' AND mode IN ('extractive','model');
