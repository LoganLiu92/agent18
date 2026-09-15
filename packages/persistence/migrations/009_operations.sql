SET ROLE agent18_owner;
CREATE TABLE core.case_captures (
 case_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 tenant_id text NOT NULL, subject text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.cases(id,organization_id,project_id,tenant_id,subject)
);
-- Cross-scope queue metadata contains no page text, logs, model output or credentials.
CREATE TABLE control.observation_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 tenant_id text NOT NULL, subject text NOT NULL, case_id uuid REFERENCES core.cases(id),
 kind text NOT NULL CHECK(kind IN ('case','inspection')), dedup_key text NOT NULL,
 config_hash text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','failed','cancelled')),
 attempts int NOT NULL DEFAULT 0, lease_until timestamptz, reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,project_id,dedup_key),
 UNIQUE(id,organization_id,project_id,tenant_id,subject)
);
CREATE INDEX observation_jobs_pending ON control.observation_jobs(state,created_at);
CREATE TABLE core.observation_reports (
 job_id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 tenant_id text NOT NULL, subject text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,organization_id,project_id,tenant_id,subject) REFERENCES control.observation_jobs(id,organization_id,project_id,tenant_id,subject)
);
CREATE TABLE control.observation_schedules (
 organization_id uuid NOT NULL, project_id uuid NOT NULL, next_due timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,project_id)
);
CREATE TABLE control.observation_incidents (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, check_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('open','acknowledged','resolved')), occurrences int NOT NULL DEFAULT 1,
 last_job_id uuid NOT NULL REFERENCES control.observation_jobs(id),
 opened_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,project_id,check_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['case_captures','observation_reports'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY scope_isolation ON core.%I USING (organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid AND tenant_id=current_setting(''agent18.tenant_id'',true) AND subject=current_setting(''agent18.subject'',true)) WITH CHECK (organization_id=nullif(current_setting(''agent18.organization_id'',true),'''')::uuid AND project_id=nullif(current_setting(''agent18.project_id'',true),'''')::uuid AND tenant_id=current_setting(''agent18.tenant_id'',true) AND subject=current_setting(''agent18.subject'',true))',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON core.case_captures,core.observation_reports TO agent18_app;
GRANT SELECT,INSERT,UPDATE ON control.observation_jobs,control.observation_schedules,control.observation_incidents TO agent18_app;
RESET ROLE;

SET ROLE agent18_owner;
INSERT INTO control.providers(id,version,review,transport,capabilities,reviewed_at,reviewed_by) VALUES('observability','1.0.0','approved','http','["operations.observe"]'::jsonb,now(),'migration-009');
INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas,reviewed_at,reviewed_by) VALUES('operations.observe',1,'approved','READ','READ','ENGINEERING','observability','operations.observe','LOW','["log","metric","health"]'::jsonb,'["development","staging","production"]'::jsonb,'{"input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"checkId":{"type":"string","maxLength":64},"configHash":{"type":"string","pattern":"^[a-f0-9]{64}$"},"mode":{"type":"string","enum":["case","inspection"]},"traceId":{"type":"string","pattern":"^[a-fA-F0-9]{16,32}$"},"observedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"}},"required":["checkId","configHash","mode","observedAt"],"additionalProperties":false},"output":{"$schema":"https://json-schema.org/draft/2020-12/schema","maxItems":50,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"kind":{"type":"string","enum":["knowledge","business","log","trace","metric","error","deployment","commit","code"]},"source":{"type":"string","minLength":1,"maxLength":300},"observedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"},"resource":{"type":"object","properties":{"namespace":{"type":"string","maxLength":80},"type":{"type":"string","minLength":1,"maxLength":80},"id":{"type":"string","minLength":1,"maxLength":300}},"required":["type","id"],"additionalProperties":false},"summary":{"type":"string","minLength":1,"maxLength":2000},"artifactRef":{"anyOf":[{"type":"string","pattern":"^artifact:\\/\\/[a-f0-9-]{36}$"},{"type":"null"}]},"visibility":{"type":"string","enum":["PUBLIC","TENANT","INTERNAL","ENGINEERING"]},"sensitivity":{"type":"string","enum":["PUBLIC","CONFIDENTIAL","RESTRICTED"]},"scope":{"type":"object","properties":{"organizationId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"projectId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"tenantId":{"type":"string","minLength":1,"maxLength":128},"subject":{"type":"string","minLength":1,"maxLength":128}},"required":["organizationId","projectId","tenantId","subject"],"additionalProperties":false},"provenance":{"type":"object","properties":{"providerId":{"type":"string","minLength":1,"maxLength":100},"toolId":{"type":"string","minLength":1,"maxLength":100},"toolVersion":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"sourceVersion":{"type":"string","maxLength":100},"requestId":{"type":"string","maxLength":128}},"required":["providerId","toolId","toolVersion","sourceVersion","requestId"],"additionalProperties":false},"citation":{"type":"object","properties":{"id":{"type":"string","maxLength":200},"title":{"type":"string","maxLength":200},"excerpt":{"type":"string","maxLength":2000},"source":{"type":"string","maxLength":300},"version":{"type":"string","maxLength":100},"observedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"}},"required":["id","title","excerpt","source","version","observedAt"],"additionalProperties":false}},"required":["id","kind","source","observedAt","resource","summary","artifactRef","visibility","sensitivity","scope","provenance"],"additionalProperties":false}}}'::jsonb,now(),'migration-009');
RESET ROLE;
