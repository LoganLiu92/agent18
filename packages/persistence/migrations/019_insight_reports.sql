SET ROLE agent18_owner;
CREATE TABLE control.insight_reports (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL,project_id uuid NOT NULL,
 operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 title text NOT NULL,tenant_ids text[] NOT NULL,all_tenants boolean NOT NULL,
 definition_version text NOT NULL,payload jsonb NOT NULL,request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id),
 UNIQUE(operator_id,organization_id,project_id,request_key)
);
ALTER TABLE control.insight_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.insight_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_scope ON control.insight_reports TO agent18_app USING(
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid
 AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM control.operator_sessions s JOIN control.operator_accounts a ON a.id=s.operator_id
 JOIN control.operator_tenant_grants g ON g.operator_id=a.id AND g.organization_id=insight_reports.organization_id AND g.project_id=insight_reports.project_id
 WHERE s.operator_id=insight_reports.operator_id AND s.token_hash=current_setting('agent18.operator_session',true)
 AND a.enabled AND NOT a.must_change_password AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'
 AND ((g.all_tenants) OR (NOT insight_reports.all_tenants AND insight_reports.tenant_ids <@ g.tenant_ids))
 AND EXISTS(SELECT 1 WHERE a.administrator OR EXISTS(SELECT 1 FROM control.operator_memberships m WHERE m.operator_id=a.id AND m.organization_id=insight_reports.organization_id AND m.project_id=insight_reports.project_id AND m.roles && ARRAY['support','engineer']::text[]))))
 WITH CHECK(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid AND EXISTS(SELECT 1 FROM control.operator_sessions s WHERE s.operator_id=insight_reports.operator_id AND s.token_hash=current_setting('agent18.operator_session',true)));
GRANT SELECT,INSERT,DELETE ON control.insight_reports TO agent18_app;
CREATE INDEX insight_reports_owner ON control.insight_reports(operator_id,organization_id,project_id,created_at DESC);
RESET ROLE;
