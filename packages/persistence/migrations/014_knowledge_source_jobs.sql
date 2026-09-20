SET ROLE agent18_owner;
CREATE TABLE knowledge.connections (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 source_key text NOT NULL, name text NOT NULL, spec jsonb NOT NULL, mode text NOT NULL CHECK(mode IN ('extractive','model')),
 created_by uuid NOT NULL REFERENCES control.operator_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,project_id,source_key), UNIQUE(id,organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
CREATE TABLE control.knowledge_jobs (
 id uuid PRIMARY KEY, connection_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
 lease_id uuid, lease_until timestamptz, build_id uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
 FOREIGN KEY(connection_id,organization_id,project_id) REFERENCES knowledge.connections(id,organization_id,project_id)
);
CREATE INDEX knowledge_jobs_queue ON control.knowledge_jobs(state,created_at);
CREATE UNIQUE INDEX knowledge_jobs_pending ON control.knowledge_jobs(connection_id) WHERE state IN ('queued','running');
ALTER TABLE knowledge.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.connections FORCE ROW LEVEL SECURITY;
ALTER TABLE control.knowledge_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.knowledge_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON knowledge.connections FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON knowledge.connections FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
CREATE POLICY indexer_read ON knowledge.connections FOR SELECT TO agent18_indexer USING(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid);
CREATE POLICY operator_read ON control.knowledge_jobs FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON control.knowledge_jobs FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
CREATE POLICY operator_update ON control.knowledge_jobs FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'configure')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
CREATE POLICY indexer_jobs ON control.knowledge_jobs TO agent18_indexer USING(true) WITH CHECK(true);
GRANT SELECT,INSERT ON knowledge.connections TO agent18_app;
GRANT SELECT ON knowledge.connections TO agent18_indexer;
GRANT SELECT,INSERT,UPDATE ON control.knowledge_jobs TO agent18_app;
GRANT SELECT,UPDATE ON control.knowledge_jobs TO agent18_indexer;
GRANT USAGE ON SCHEMA control TO agent18_indexer;
CREATE FUNCTION control.knowledge_job_actor_enabled(actor uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM control.operator_accounts a WHERE a.id=actor AND a.enabled AND a.administrator AND NOT a.must_change_password)
$$;
REVOKE ALL ON FUNCTION control.knowledge_job_actor_enabled(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.knowledge_job_actor_enabled(uuid) TO agent18_indexer;
ALTER TABLE knowledge.documents ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]';
ALTER TABLE knowledge.documents ADD COLUMN origin_article_id uuid UNIQUE REFERENCES knowledge.articles(id);
RESET ROLE;
