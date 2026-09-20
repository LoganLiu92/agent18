SET ROLE agent18_owner;
CREATE TABLE control.report_schedules (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 title text NOT NULL,definition jsonb NOT NULL,tenant_ids text[] NOT NULL,all_tenants boolean NOT NULL,
 archived boolean NOT NULL DEFAULT false,enabled boolean NOT NULL DEFAULT true,version int NOT NULL DEFAULT 1,next_due timestamptz NOT NULL,last_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id),UNIQUE(id,organization_id,project_id)
);
CREATE TABLE control.automation_jobs (
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 schedule_id uuid,kind text NOT NULL CHECK(kind IN ('support_report','analytics_report')),dedup_key text NOT NULL,
 definition jsonb NOT NULL,tenant_ids text[] NOT NULL,all_tenants boolean NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed','cancelled')),
 attempts int NOT NULL DEFAULT 0,lease_id uuid,lease_until timestamptz,next_attempt timestamptz NOT NULL DEFAULT now(),reason text,report_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id),
 FOREIGN KEY(schedule_id,organization_id,project_id) REFERENCES control.report_schedules(id,organization_id,project_id),
 UNIQUE(organization_id,project_id,dedup_key)
);
-- Runtime scheduling metadata is not exposed through customer routes. No customer token is retained.
GRANT SELECT,INSERT,UPDATE ON control.report_schedules,control.automation_jobs TO agent18_app;
CREATE INDEX report_schedules_due ON control.report_schedules(next_due) WHERE enabled AND NOT archived;
CREATE INDEX report_schedules_owner ON control.report_schedules(operator_id,project_id,created_at DESC);
CREATE INDEX automation_owner ON control.automation_jobs(operator_id,project_id,created_at DESC);
CREATE INDEX automation_due ON control.automation_jobs(state,next_attempt,created_at);
CREATE FUNCTION control.report_actor_allowed(actor uuid,org uuid,project uuid,all_scope boolean,tenants text[]) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM control.operator_accounts a JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=org AND g.project_id=project
 LEFT JOIN control.operator_memberships m ON m.operator_id=a.id AND m.organization_id=org AND m.project_id=project
 WHERE a.id=actor AND a.enabled AND NOT a.must_change_password AND (a.administrator OR m.roles && ARRAY['support','engineer']::text[])
 AND (g.all_tenants OR (NOT all_scope AND cardinality(tenants)>0 AND tenants <@ g.tenant_ids)));
$$;
REVOKE ALL ON FUNCTION control.report_actor_allowed(uuid,uuid,uuid,boolean,text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.report_actor_allowed(uuid,uuid,uuid,boolean,text[]) TO agent18_app;
CREATE FUNCTION control.automation_access(org uuid,project uuid,tenant text,actor uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT org=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project=nullif(current_setting('agent18.project_id',true),'')::uuid AND EXISTS(
 SELECT 1 FROM control.automation_jobs j WHERE j.id=nullif(current_setting('agent18.automation_job',true),'')::uuid
 AND j.lease_id=nullif(current_setting('agent18.automation_lease',true),'')::uuid AND j.state='running' AND j.lease_until>now()
 AND j.organization_id=org AND j.project_id=project AND (actor IS NULL OR actor=j.operator_id)
 AND (tenant IS NULL OR j.all_tenants OR tenant=ANY(j.tenant_ids))
 AND control.report_actor_allowed(j.operator_id,org,project,j.all_tenants,j.tenant_ids));
$$;
REVOKE ALL ON FUNCTION control.automation_access(uuid,uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control.automation_access(uuid,uuid,text,uuid) TO agent18_app;
CREATE POLICY automation_read ON core.cases FOR SELECT TO agent18_app USING(control.automation_access(organization_id,project_id,tenant_id));
CREATE POLICY automation_report ON control.insight_reports FOR INSERT TO agent18_app WITH CHECK(control.automation_access(organization_id,project_id,NULL,operator_id));
RESET ROLE;
