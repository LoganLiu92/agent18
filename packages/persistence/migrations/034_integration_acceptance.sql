SET ROLE agent18_owner;
CREATE TABLE control.integration_checks (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 environment text NOT NULL, kind text NOT NULL, config_hash text NOT NULL,
 status text NOT NULL CHECK(status IN ('passed','failed','not_applicable')),
 note text NOT NULL, evidence_ref text NOT NULL, actor_id uuid NOT NULL REFERENCES control.operator_accounts(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
CREATE INDEX integration_checks_latest ON control.integration_checks(organization_id,project_id,environment,kind,created_at DESC);
ALTER TABLE control.integration_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.integration_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON control.integration_checks FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON control.integration_checks FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
GRANT SELECT,INSERT ON control.integration_checks TO agent18_app;
RESET ROLE;
