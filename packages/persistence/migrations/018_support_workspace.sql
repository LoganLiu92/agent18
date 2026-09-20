SET ROLE agent18_owner;
CREATE TABLE control.operator_tenant_grants (
 operator_id uuid NOT NULL REFERENCES control.operator_accounts(id), organization_id uuid NOT NULL, project_id uuid NOT NULL,
 all_tenants boolean NOT NULL DEFAULT false, tenant_ids text[] NOT NULL DEFAULT '{}',
 updated_by uuid NOT NULL REFERENCES control.operator_accounts(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(operator_id,organization_id,project_id), FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
GRANT SELECT,INSERT,UPDATE,DELETE ON control.operator_tenant_grants TO agent18_app;
CREATE FUNCTION control.operator_support_access(org uuid, project uuid, tenant text, capability text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT org=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project=nullif(current_setting('agent18.project_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM control.operator_accounts a JOIN control.operator_sessions s ON s.operator_id=a.id
 JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=org AND g.project_id=project
 LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=org AND m.project_id=project
 WHERE s.token_hash=current_setting('agent18.operator_session',true) AND a.enabled AND NOT a.must_change_password
 AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes' AND (g.all_tenants OR tenant=ANY(g.tenant_ids))
 AND (a.administrator OR CASE WHEN capability='engineering' THEN 'engineer'=ANY(m.roles) ELSE m.roles && ARRAY['support','engineer']::text[] END))
$$;
REVOKE ALL ON FUNCTION control.operator_support_access(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.operator_support_access(uuid,uuid,text,text) TO agent18_app;
CREATE POLICY operator_catalogue ON core.tenants FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'configure') OR control.operator_support_access(organization_id,project_id,tenant_id,'read'));
ALTER TABLE core.cases ADD COLUMN case_type text NOT NULL DEFAULT 'SUPPORT_TICKET' CHECK(case_type IN ('SUPPORT_TICKET','MONITORING_ALERT','INCIDENT','AI_FINDING','MANUAL')),
 ADD COLUMN ticket_status text NOT NULL DEFAULT 'new' CHECK(ticket_status IN ('new','open','investigating','waiting_customer','waiting_internal','resolved','closed')),
 ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
 ADD COLUMN assignee_id uuid REFERENCES control.operator_accounts(id), ADD COLUMN team text NOT NULL DEFAULT '',
 ADD COLUMN ticket_version int NOT NULL DEFAULT 1, ADD COLUMN resolution jsonb,
 ADD COLUMN public_resolution text, ADD COLUMN resolved_at timestamptz,
 ADD COLUMN deleted_at timestamptz,
 ADD CONSTRAINT cases_project_unique UNIQUE(id,organization_id,project_id);
UPDATE core.cases SET ticket_status=CASE WHEN status='resolved' THEN 'resolved' ELSE 'open' END;
CREATE FUNCTION core.sync_ticket_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.ticket_version := OLD.ticket_version+1;
 IF NEW.ticket_status IS DISTINCT FROM OLD.ticket_status THEN
  NEW.status := CASE WHEN NEW.ticket_status IN ('resolved','closed') THEN 'resolved' ELSE 'needs_human' END;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  IF NEW.status='resolved' THEN NEW.ticket_status:='resolved';
  ELSIF OLD.status='resolved' THEN NEW.ticket_status:='open'; NEW.resolved_at:=NULL; END IF;
 END IF;
 IF NEW.ticket_status IN ('resolved','closed') AND OLD.ticket_status NOT IN ('resolved','closed') THEN NEW.resolved_at:=now(); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_ticket_status BEFORE UPDATE ON core.cases FOR EACH ROW EXECUTE FUNCTION core.sync_ticket_status();
ALTER TABLE core.case_messages ADD COLUMN operator_id uuid REFERENCES control.operator_accounts(id);
CREATE TABLE core.ticket_notes (
 id uuid PRIMARY KEY, case_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 body text NOT NULL, operator_id uuid NOT NULL REFERENCES control.operator_accounts(id), request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.cases(id,organization_id,project_id,tenant_id,subject), UNIQUE(case_id,request_key)
);
CREATE TABLE core.ticket_events (
 id uuid PRIMARY KEY, case_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 action text NOT NULL, operator_id uuid REFERENCES control.operator_accounts(id), detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.cases(id,organization_id,project_id,tenant_id,subject)
);
CREATE INDEX ticket_notes_case ON core.ticket_notes(case_id,created_at,id);
CREATE INDEX ticket_events_case ON core.ticket_events(case_id,created_at,id);
CREATE INDEX tickets_queue ON core.cases(organization_id,project_id,updated_at DESC,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['cases','case_messages','ticket_notes','ticket_events'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY operator_read ON core.%I FOR SELECT TO agent18_app USING(control.operator_support_access(organization_id,project_id,tenant_id,''read''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['case_messages','ticket_notes','ticket_events'] LOOP
  EXECUTE format('CREATE POLICY operator_insert ON core.%I FOR INSERT TO agent18_app WITH CHECK(control.operator_support_access(organization_id,project_id,tenant_id,''read''))',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['runs','evidence','audit','case_captures','observation_reports'] LOOP
  EXECUTE format('CREATE POLICY operator_read ON core.%I FOR SELECT TO agent18_app USING(control.operator_support_access(organization_id,project_id,tenant_id,''engineering''))',t);
 END LOOP;
END $$;
CREATE POLICY operator_update ON core.cases FOR UPDATE TO agent18_app USING(control.operator_support_access(organization_id,project_id,tenant_id,'read')) WITH CHECK(control.operator_support_access(organization_id,project_id,tenant_id,'read'));
GRANT SELECT,INSERT ON core.ticket_notes,core.ticket_events TO agent18_app;

CREATE TABLE core.conversations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 title text NOT NULL, request_key uuid NOT NULL, next_sequence int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
 FOREIGN KEY(organization_id,project_id,tenant_id) REFERENCES core.tenants,
 UNIQUE(id,organization_id,project_id,tenant_id,subject), UNIQUE(organization_id,project_id,tenant_id,subject,request_key)
);
CREATE TABLE core.conversation_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 sequence int NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant')), body text NOT NULL,
 origin text NOT NULL DEFAULT 'client_display' CHECK(origin='client_display'), request_key uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,organization_id,project_id,tenant_id,subject) REFERENCES core.conversations(id,organization_id,project_id,tenant_id,subject),
 UNIQUE(conversation_id,sequence),UNIQUE(conversation_id,request_key)
);
CREATE TABLE core.conversation_cases (
 conversation_id uuid NOT NULL, case_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,case_id),
 FOREIGN KEY(conversation_id,organization_id,project_id,tenant_id,subject) REFERENCES core.conversations(id,organization_id,project_id,tenant_id,subject),
 FOREIGN KEY(case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.cases(id,organization_id,project_id,tenant_id,subject)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['conversations','conversation_messages','conversation_cases'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY customer_scope ON core.%I TO agent18_app USING(organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid AND tenant_id=current_setting(''agent18.tenant_id'',true) AND subject=current_setting(''agent18.subject'',true)) WITH CHECK(organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid AND tenant_id=current_setting(''agent18.tenant_id'',true) AND subject=current_setting(''agent18.subject'',true))',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON core.conversations,core.conversation_messages TO agent18_app;
GRANT SELECT,INSERT,DELETE ON core.conversation_cases TO agent18_app;
CREATE INDEX conversations_scope ON core.conversations(organization_id,project_id,tenant_id,subject,updated_at DESC,id);
CREATE TABLE control.privacy_tombstones (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 resource_type text NOT NULL CHECK(resource_type IN ('conversation','ticket','attachment','runtime_evidence')),
 resource_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(resource_type,resource_id)
);
GRANT SELECT,INSERT ON control.privacy_tombstones TO agent18_app;
ALTER TABLE knowledge.documents ADD COLUMN origin_case_id uuid, ADD COLUMN origin_case_version int,
 ADD CONSTRAINT document_case_origin FOREIGN KEY(origin_case_id,organization_id,project_id) REFERENCES core.cases(id,organization_id,project_id),
 ADD CONSTRAINT document_case_version UNIQUE(origin_case_id,origin_case_version);
ALTER TABLE control.privacy_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.privacy_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_scope ON control.privacy_tombstones TO agent18_app USING(
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)) WITH CHECK(
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true));
RESET ROLE;
