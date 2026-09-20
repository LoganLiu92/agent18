SET ROLE agent18_owner;
CREATE TABLE control.deployment_records(
 id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,service text NOT NULL,environment text NOT NULL,
 source_id uuid NOT NULL,commit_hash text NOT NULL,artifact_digest text NOT NULL,deployed_at timestamptz NOT NULL,evidence_url text NOT NULL,note text NOT NULL,
 attestation text NOT NULL CHECK(attestation IN ('operator','signed_pipeline')),actor_id uuid REFERENCES control.operator_accounts(id),pipeline text,payload_hash text NOT NULL,
 revoked_at timestamptz,revoke_reason text,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(source_id,organization_id,project_id) REFERENCES knowledge.sources(id,organization_id,project_id),
 UNIQUE(organization_id,project_id,service,environment,deployed_at)
);
ALTER TABLE control.deployment_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.deployment_records FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON control.deployment_records FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_write ON control.deployment_records FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
CREATE POLICY operator_revoke ON control.deployment_records FOR UPDATE TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'configure')) WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'configure'));
CREATE POLICY pipeline_read ON control.deployment_records FOR SELECT TO agent18_app USING(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid AND pipeline=current_setting('agent18.pipeline',true));
CREATE POLICY pipeline_insert ON control.deployment_records FOR INSERT TO agent18_app WITH CHECK(organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid AND attestation='signed_pipeline' AND pipeline=current_setting('agent18.pipeline',true));
GRANT SELECT,INSERT ON control.deployment_records TO agent18_app;
GRANT UPDATE(revoked_at,revoke_reason) ON control.deployment_records TO agent18_app;
CREATE INDEX deployment_lookup ON control.deployment_records(organization_id,project_id,environment,service,deployed_at DESC);
RESET ROLE;
