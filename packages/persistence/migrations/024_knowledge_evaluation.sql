SET ROLE agent18_owner;
CREATE TABLE knowledge.eval_questions (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,
 question text NOT NULL,expected_sources uuid[] NOT NULL,version int NOT NULL DEFAULT 1,enabled boolean NOT NULL DEFAULT true,
 updated_by uuid NOT NULL REFERENCES control.operator_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
CREATE TABLE knowledge.eval_runs (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),results jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['eval_questions','eval_runs'] LOOP
 EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY operator_read ON knowledge.%I FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,''read''))',t);
 EXECUTE format('CREATE POLICY operator_insert ON knowledge.%I FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,''edit''))',t);
 END LOOP;
END $$;
CREATE POLICY operator_update ON knowledge.eval_questions FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'edit')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
GRANT SELECT,INSERT,UPDATE ON knowledge.eval_questions TO agent18_app;
GRANT SELECT,INSERT ON knowledge.eval_runs TO agent18_app;
RESET ROLE;
