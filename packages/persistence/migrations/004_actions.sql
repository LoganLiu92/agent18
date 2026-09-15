SET ROLE agent18_owner;
CREATE TABLE core.action_proposals (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
 action_id text NOT NULL, registry_hash text NOT NULL, arguments jsonb NOT NULL, preview jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('proposed','executing','succeeded','rejected','uncertain','expired')),
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 FOREIGN KEY(organization_id,project_id,tenant_id) REFERENCES core.tenants
);
ALTER TABLE core.action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.action_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY action_scope ON core.action_proposals USING (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)
) WITH CHECK (
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)
);
CREATE INDEX action_scope_time ON core.action_proposals(organization_id,project_id,tenant_id,subject,created_at DESC);
GRANT SELECT,INSERT,UPDATE ON core.action_proposals TO agent18_app;
RESET ROLE;
