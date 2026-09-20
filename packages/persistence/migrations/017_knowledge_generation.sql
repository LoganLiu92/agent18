SET ROLE agent18_owner;
ALTER TABLE knowledge.builds ADD CONSTRAINT knowledge_build_scope_unique UNIQUE(id,organization_id,project_id);
-- Exact normalized excerpts used by the indexer, never reconstructed from generated prose.
CREATE TABLE knowledge.source_fragments (
 build_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 path text NOT NULL, start_line int NOT NULL CHECK(start_line>0), end_line int NOT NULL CHECK(end_line>=start_line),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), body text NOT NULL,
 PRIMARY KEY(build_id,path,start_line,end_line,content_hash),
 FOREIGN KEY(build_id,organization_id,project_id) REFERENCES knowledge.builds(id,organization_id,project_id)
);
ALTER TABLE knowledge.source_fragments ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.source_fragments FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON knowledge.source_fragments FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY indexer_read ON knowledge.source_fragments FOR SELECT TO agent18_indexer USING(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid);
CREATE POLICY indexer_insert ON knowledge.source_fragments FOR INSERT TO agent18_indexer WITH CHECK(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid AND EXISTS(SELECT 1 FROM knowledge.builds b WHERE b.id=build_id AND b.state='building'));
GRANT SELECT ON knowledge.source_fragments TO agent18_app;
GRANT SELECT,INSERT ON knowledge.source_fragments TO agent18_indexer;

CREATE TABLE control.knowledge_generation_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 topic_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','cancelled')),
 input jsonb NOT NULL, result jsonb, error_code text, lease_id uuid, lease_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz,
 UNIQUE(id,organization_id,project_id),
 FOREIGN KEY(topic_id,organization_id,project_id) REFERENCES knowledge.topics(id,organization_id,project_id)
);
CREATE INDEX knowledge_generation_queue ON control.knowledge_generation_jobs(state,created_at);
CREATE UNIQUE INDEX knowledge_generation_pending ON control.knowledge_generation_jobs(topic_id) WHERE state IN ('queued','running');
ALTER TABLE control.knowledge_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.knowledge_generation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON control.knowledge_generation_jobs FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON control.knowledge_generation_jobs FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
CREATE POLICY operator_update ON control.knowledge_generation_jobs FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'edit')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
CREATE POLICY indexer_jobs ON control.knowledge_generation_jobs TO agent18_indexer USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON control.knowledge_generation_jobs TO agent18_app;
GRANT SELECT,UPDATE ON control.knowledge_generation_jobs TO agent18_indexer;
CREATE FUNCTION control.knowledge_generation_actor_enabled(actor uuid, org uuid, project uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM control.operator_accounts a LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=org AND m.project_id=project
 WHERE a.id=actor AND a.enabled AND NOT a.must_change_password AND (a.administrator OR 'knowledge_editor'=ANY(m.roles)))
$$;
REVOKE ALL ON FUNCTION control.knowledge_generation_actor_enabled(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.knowledge_generation_actor_enabled(uuid,uuid,uuid) TO agent18_indexer;
ALTER TABLE knowledge.documents ADD COLUMN generation_job_id uuid,
 ADD COLUMN generation_index int,
 ADD COLUMN derived_from_document_id uuid,
 ADD COLUMN derived_from_version int,
 ADD CONSTRAINT document_generation_scope FOREIGN KEY(generation_job_id,organization_id,project_id) REFERENCES control.knowledge_generation_jobs(id,organization_id,project_id),
 ADD CONSTRAINT document_derivation_scope FOREIGN KEY(derived_from_document_id,organization_id,project_id) REFERENCES knowledge.documents(id,organization_id,project_id),
 ADD CONSTRAINT document_generation_unique UNIQUE(generation_job_id,generation_index),
 ADD CONSTRAINT document_derivation_unique UNIQUE(derived_from_document_id,derived_from_version);
RESET ROLE;
