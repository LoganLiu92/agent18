SET ROLE agent18_owner;
CREATE TABLE knowledge.conflicts (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,topic_id uuid NOT NULL,
 rule_key text NOT NULL,comparison_scope text NOT NULL,claims jsonb NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','dismissed')),
 version int NOT NULL DEFAULT 1,resolution text,created_by uuid NOT NULL REFERENCES control.operator_accounts(id),
 resolved_by uuid REFERENCES control.operator_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(topic_id,organization_id,project_id) REFERENCES knowledge.topics(id,organization_id,project_id)
);
CREATE TABLE knowledge.conflict_events (
 id uuid PRIMARY KEY,conflict_id uuid NOT NULL REFERENCES knowledge.conflicts(id),organization_id uuid NOT NULL,project_id uuid NOT NULL,
 version int NOT NULL,action text NOT NULL,reason text NOT NULL,actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conflicts','conflict_events'] LOOP
 EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY operator_read ON knowledge.%I FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,''read''))',t);
 EXECUTE format('CREATE POLICY operator_insert ON knowledge.%I FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,''edit'') OR control.operator_knowledge_access(organization_id,project_id,''publish''))',t);
 END LOOP;
END $$;
CREATE POLICY operator_update ON knowledge.conflicts FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'publish')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'publish'));
GRANT SELECT,INSERT,UPDATE ON knowledge.conflicts TO agent18_app;
GRANT SELECT,INSERT ON knowledge.conflict_events TO agent18_app;
CREATE INDEX conflicts_project_state ON knowledge.conflicts(organization_id,project_id,state,updated_at DESC,id);
RESET ROLE;
