CREATE SCHEMA knowledge AUTHORIZATION agent18_owner;
SET ROLE agent18_owner;
CREATE TABLE knowledge.sources (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, source_key text NOT NULL,
 name text NOT NULL, audience text NOT NULL CHECK(audience IN ('internal','customer')),
 tenant_ids text[] NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT true, active_build_id uuid,
 UNIQUE(organization_id,project_id,source_key), UNIQUE(id,organization_id,project_id)
);
CREATE TABLE knowledge.builds (
 id uuid PRIMARY KEY, source_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 revision text NOT NULL, fingerprint text NOT NULL, mode text NOT NULL, state text NOT NULL CHECK(state IN ('building','ready','failed')),
 report jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(source_id,organization_id,project_id) REFERENCES knowledge.sources(id,organization_id,project_id),
 UNIQUE(id,source_id,organization_id,project_id)
);
ALTER TABLE knowledge.sources ADD CONSTRAINT source_active_build FOREIGN KEY(active_build_id,id,organization_id,project_id) REFERENCES knowledge.builds(id,source_id,organization_id,project_id);
CREATE TABLE knowledge.articles (
 id uuid PRIMARY KEY, build_id uuid NOT NULL, source_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 title text NOT NULL, body text NOT NULL, category text NOT NULL, tokens text[] NOT NULL, refs jsonb NOT NULL,
 revision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(build_id,source_id,organization_id,project_id) REFERENCES knowledge.builds(id,source_id,organization_id,project_id)
);
CREATE INDEX knowledge_terms ON knowledge.articles USING gin(tokens);
CREATE INDEX knowledge_build_articles ON knowledge.articles(build_id);
CREATE TABLE knowledge.cache (
 organization_id uuid NOT NULL, project_id uuid NOT NULL, key text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(organization_id,project_id,key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sources','builds','articles','cache'] LOOP
  EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY indexer_scope ON knowledge.%I TO agent18_indexer USING (organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid) WITH CHECK (organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY customer_sources ON knowledge.sources FOR SELECT TO agent18_app USING (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND audience='customer' AND enabled AND active_build_id IS NOT NULL
 AND (cardinality(tenant_ids)=0 OR current_setting('agent18.tenant_id',true)=ANY(tenant_ids))
);
CREATE POLICY customer_articles ON knowledge.articles FOR SELECT TO agent18_app USING (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=source_id AND s.active_build_id=build_id)
);
GRANT USAGE ON SCHEMA knowledge TO agent18_app,agent18_indexer;
GRANT SELECT ON knowledge.sources,knowledge.articles TO agent18_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA knowledge TO agent18_indexer;
REVOKE ALL ON SCHEMA knowledge FROM PUBLIC;
RESET ROLE;
