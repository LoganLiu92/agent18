SET ROLE agent18_owner;
ALTER TABLE knowledge.topics ADD COLUMN discovery_key text, ADD COLUMN merged_into uuid,
 ADD CONSTRAINT topic_merge_scope FOREIGN KEY(merged_into,organization_id,project_id) REFERENCES knowledge.topics(id,organization_id,project_id),
 ADD CONSTRAINT topic_discovery_unique UNIQUE(organization_id,project_id,discovery_key);
CREATE TABLE knowledge.publication_sets(
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 title text NOT NULL,request_key uuid NOT NULL,input_hash text NOT NULL,members jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,project_id,request_key),FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
ALTER TABLE knowledge.publication_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.publication_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON knowledge.publication_sets FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON knowledge.publication_sets FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'publish'));
GRANT SELECT,INSERT ON knowledge.publication_sets TO agent18_app;
CREATE POLICY operator_review ON knowledge.topic_evidence FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'edit')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
GRANT UPDATE(relation,note,confirmed,linked_by) ON knowledge.topic_evidence TO agent18_app;
RESET ROLE;
