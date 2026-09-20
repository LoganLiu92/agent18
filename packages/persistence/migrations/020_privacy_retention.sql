SET ROLE agent18_owner;
ALTER TABLE control.privacy_tombstones DROP CONSTRAINT privacy_tombstones_resource_type_check;
ALTER TABLE control.privacy_tombstones ADD CONSTRAINT privacy_tombstones_resource_type_check CHECK(resource_type IN ('conversation','ticket','attachment','runtime_evidence','insight','audit'));
CREATE TABLE control.retention_policies (
 organization_id uuid NOT NULL,project_id uuid NOT NULL,
 conversation_days int CHECK(conversation_days BETWEEN 1 AND 3650),
 ticket_days int CHECK(ticket_days BETWEEN 1 AND 3650),
 attachment_days int CHECK(attachment_days BETWEEN 1 AND 3650),
 evidence_days int CHECK(evidence_days BETWEEN 1 AND 3650),
 audit_days int CHECK(audit_days BETWEEN 30 AND 3650),
 updated_by uuid NOT NULL REFERENCES control.operator_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,project_id),FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
GRANT SELECT,INSERT,UPDATE ON control.retention_policies TO agent18_app;
CREATE POLICY operator_privacy_insert ON control.privacy_tombstones FOR INSERT TO agent18_app WITH CHECK(
 resource_type='insight' AND organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid AND EXISTS(SELECT 1 FROM control.operator_sessions s WHERE s.operator_id::text=subject AND s.token_hash=current_setting('agent18.operator_session',true)));
RESET ROLE;
