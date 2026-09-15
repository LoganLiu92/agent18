SET ROLE agent18_owner;
ALTER TABLE core.cases DROP CONSTRAINT cases_status_check;
ALTER TABLE core.cases ADD CONSTRAINT cases_status_check CHECK(status IN ('open','needs_human','resolved'));
CREATE TABLE core.case_messages (
 id uuid PRIMARY KEY, case_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 tenant_id text NOT NULL, subject text NOT NULL, author_kind text NOT NULL CHECK(author_kind IN ('customer','support')),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.cases(id,organization_id,project_id,tenant_id,subject),
 UNIQUE(case_id,author_kind,request_key)
);
ALTER TABLE core.case_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.case_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY message_scope ON core.case_messages USING (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)
) WITH CHECK (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)
);
CREATE INDEX case_messages_order ON core.case_messages(case_id,created_at,id);
GRANT SELECT,INSERT ON core.case_messages TO agent18_app;
RESET ROLE;
