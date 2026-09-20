SET ROLE agent18_owner;
-- Operator access is bound to a live session and a project, never to a customer token.
CREATE FUNCTION control.operator_knowledge_access(org uuid, project uuid, capability text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT org=nullif(current_setting('agent18.organization_id',true),'')::uuid
 AND project=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND EXISTS (
 SELECT 1 FROM control.operator_sessions s JOIN control.operator_accounts a ON a.id=s.operator_id
 LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=org AND m.project_id=project
 WHERE s.token_hash=current_setting('agent18.operator_session',true)
 AND a.enabled AND NOT a.must_change_password AND s.expires_at>now()
 AND s.last_seen_at>now()-interval '30 minutes'
 AND (a.administrator OR CASE capability
 WHEN 'read' THEN m.roles && ARRAY['engineer','knowledge_editor','knowledge_publisher']::text[]
 WHEN 'edit' THEN 'knowledge_editor'=ANY(m.roles)
 WHEN 'publish' THEN 'knowledge_publisher'=ANY(m.roles)
 ELSE false END))
$$;
REVOKE ALL ON FUNCTION control.operator_knowledge_access(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.operator_knowledge_access(uuid,uuid,text) TO agent18_app;

CREATE TABLE knowledge.documents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 title text NOT NULL, body text NOT NULL, category text NOT NULL,
 audience text NOT NULL CHECK(audience IN ('internal','customer')),
 version int NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','in_review','approved','published')),
 published_build_id uuid, updated_by uuid NOT NULL REFERENCES control.operator_accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id),
 UNIQUE(id,organization_id,project_id)
);
CREATE TABLE knowledge.document_history (
 id uuid PRIMARY KEY, document_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 version int NOT NULL, action text NOT NULL, snapshot jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES control.operator_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(document_id,organization_id,project_id) REFERENCES knowledge.documents(id,organization_id,project_id)
);
CREATE INDEX knowledge_documents_project ON knowledge.documents(organization_id,project_id,updated_at DESC,id);
CREATE INDEX knowledge_document_history_document ON knowledge.document_history(document_id,created_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sources','builds','articles','documents','document_history'] LOOP
  EXECUTE format('ALTER TABLE knowledge.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE knowledge.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY operator_read ON knowledge.%I FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,''read''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['documents','document_history'] LOOP
  EXECUTE format('CREATE POLICY operator_insert ON knowledge.%I FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,''edit'') OR control.operator_knowledge_access(organization_id,project_id,''publish''))',t);
 END LOOP;
END $$;
CREATE POLICY operator_update ON knowledge.documents FOR UPDATE TO agent18_app
 USING(control.operator_knowledge_access(organization_id,project_id,'edit') OR control.operator_knowledge_access(organization_id,project_id,'publish'))
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'edit') OR control.operator_knowledge_access(organization_id,project_id,'publish'));
CREATE POLICY operator_source_insert ON knowledge.sources FOR INSERT TO agent18_app
 WITH CHECK(source_key='staff-'||id::text AND control.operator_knowledge_access(organization_id,project_id,'publish'));
CREATE POLICY operator_source_update ON knowledge.sources FOR UPDATE TO agent18_app
 USING(source_key='staff-'||id::text AND control.operator_knowledge_access(organization_id,project_id,'publish'))
 WITH CHECK(source_key='staff-'||id::text AND control.operator_knowledge_access(organization_id,project_id,'publish'));
CREATE POLICY operator_build_insert ON knowledge.builds FOR INSERT TO agent18_app
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'publish') AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=source_id AND s.source_key='staff-'||s.id::text));
CREATE POLICY operator_article_insert ON knowledge.articles FOR INSERT TO agent18_app
 WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'publish') AND EXISTS(SELECT 1 FROM knowledge.sources s WHERE s.id=source_id AND s.source_key='staff-'||s.id::text));
GRANT SELECT,INSERT,UPDATE ON knowledge.documents TO agent18_app;
GRANT SELECT,INSERT ON knowledge.document_history,knowledge.builds TO agent18_app;
GRANT INSERT,UPDATE ON knowledge.sources TO agent18_app;
GRANT INSERT ON knowledge.articles TO agent18_app;
RESET ROLE;
