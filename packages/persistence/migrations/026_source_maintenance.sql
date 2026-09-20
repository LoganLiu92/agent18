SET ROLE agent18_owner;
ALTER TABLE knowledge.connections ADD COLUMN version int NOT NULL DEFAULT 1, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE control.knowledge_jobs ADD COLUMN connection_version int, ADD COLUMN source_input jsonb;
GRANT UPDATE ON knowledge.connections TO agent18_app;
CREATE POLICY operator_update ON knowledge.connections FOR UPDATE TO agent18_app
 USING(control.operator_knowledge_access(organization_id,project_id,'configure'))
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
RESET ROLE;
