SET ROLE agent18_owner;
CREATE TABLE knowledge.topics (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 domain text NOT NULL, title text NOT NULL, description text NOT NULL DEFAULT '',
 state text NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate','confirmed','excluded')),
 required_categories text[] NOT NULL DEFAULT ARRAY['overview','workflows','troubleshooting']::text[],
 version int NOT NULL DEFAULT 1, updated_by uuid NOT NULL REFERENCES control.operator_accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
CREATE TABLE knowledge.topic_documents (
 topic_id uuid NOT NULL, document_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 linked_by uuid NOT NULL REFERENCES control.operator_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(topic_id,document_id),
 FOREIGN KEY(topic_id,organization_id,project_id) REFERENCES knowledge.topics(id,organization_id,project_id),
 FOREIGN KEY(document_id,organization_id,project_id) REFERENCES knowledge.documents(id,organization_id,project_id)
);
CREATE INDEX knowledge_topics_project ON knowledge.topics(organization_id,project_id,domain,title,id);
CREATE INDEX knowledge_topic_documents_document ON knowledge.topic_documents(document_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topics','topic_documents'] LOOP
  EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY operator_read ON knowledge.%I FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,''read''))',t);
  EXECUTE format('CREATE POLICY operator_insert ON knowledge.%I FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,''edit''))',t);
 END LOOP;
END $$;
CREATE POLICY operator_update ON knowledge.topics FOR UPDATE TO agent18_app
 USING(control.operator_knowledge_access(organization_id,project_id,'edit'))
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit'));
CREATE POLICY operator_unlink ON knowledge.topic_documents FOR DELETE TO agent18_app
 USING(control.operator_knowledge_access(organization_id,project_id,'edit'));
GRANT SELECT,INSERT,UPDATE ON knowledge.topics TO agent18_app;
GRANT SELECT,INSERT,DELETE ON knowledge.topic_documents TO agent18_app;
RESET ROLE;
