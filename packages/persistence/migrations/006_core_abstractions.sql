SET ROLE agent18_owner;
CREATE TABLE control.providers (
 id text PRIMARY KEY, version text NOT NULL, review text NOT NULL CHECK(review IN ('pending','approved','revoked')),
 transport text NOT NULL CHECK(transport IN ('native','http','openapi','mcp')), capabilities jsonb NOT NULL,
 reviewed_at timestamptz, reviewed_by text
);
INSERT INTO control.providers VALUES
 ('knowledge','1.0.0','approved','native','["knowledge.search"]',now(),'migration-006'),
 ('saas-api','1.0.0','approved','openapi','["business.inspect"]',now(),'migration-006'),
 ('saas-bridge','1.0.0','approved','http','["business.propose","business.execute"]',now(),'migration-006');
GRANT SELECT ON control.providers TO agent18_app;
ALTER TABLE control.tools ADD COLUMN capability text, ADD COLUMN risk text NOT NULL DEFAULT 'LOW',
 ADD COLUMN resource_types jsonb NOT NULL DEFAULT '[]', ADD COLUMN environment_policy jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN schemas jsonb NOT NULL DEFAULT '{}', ADD COLUMN reviewed_at timestamptz, ADD COLUMN reviewed_by text;
UPDATE control.tools SET provider='knowledge' WHERE id='knowledge.search' AND provider='knowledge-fixture';
INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas,reviewed_at,reviewed_by) VALUES('knowledge.search',1,'approved','READ','READ','CUSTOMER','knowledge','knowledge.search','LOW','["knowledge"]'::jsonb,'["development","staging","production"]'::jsonb,'{"input":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"query":{"type":"string","minLength":2,"maxLength":300},"limit":{"type":"integer","minimum":1,"maximum":5}},"required":["query","limit"],"additionalProperties":false},"output":{"$schema":"https://json-schema.org/draft/2020-12/schema","maxItems":50,"type":"array","items":{"type":"object","properties":{"id":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"kind":{"type":"string","enum":["knowledge","business","log","trace","metric","error","deployment","commit","code"]},"source":{"type":"string","minLength":1,"maxLength":300},"observedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"},"resource":{"type":"object","properties":{"namespace":{"type":"string","maxLength":80},"type":{"type":"string","minLength":1,"maxLength":80},"id":{"type":"string","minLength":1,"maxLength":300}},"required":["type","id"],"additionalProperties":false},"summary":{"type":"string","minLength":1,"maxLength":2000},"artifactRef":{"anyOf":[{"type":"string","pattern":"^artifact:\\/\\/[a-f0-9-]{36}$"},{"type":"null"}]},"visibility":{"type":"string","enum":["PUBLIC","TENANT","INTERNAL","ENGINEERING"]},"sensitivity":{"type":"string","enum":["PUBLIC","CONFIDENTIAL","RESTRICTED"]},"scope":{"type":"object","properties":{"organizationId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"projectId":{"type":"string","format":"uuid","pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"},"tenantId":{"type":"string","minLength":1,"maxLength":128},"subject":{"type":"string","minLength":1,"maxLength":128}},"required":["organizationId","projectId","tenantId","subject"],"additionalProperties":false},"provenance":{"type":"object","properties":{"providerId":{"type":"string","minLength":1,"maxLength":100},"toolId":{"type":"string","minLength":1,"maxLength":100},"toolVersion":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"sourceVersion":{"type":"string","maxLength":100},"requestId":{"type":"string","maxLength":128}},"required":["providerId","toolId","toolVersion","sourceVersion","requestId"],"additionalProperties":false},"citation":{"type":"object","properties":{"id":{"type":"string","maxLength":200},"title":{"type":"string","maxLength":200},"excerpt":{"type":"string","maxLength":2000},"source":{"type":"string","maxLength":300},"version":{"type":"string","maxLength":100},"observedAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z))$"}},"required":["id","title","excerpt","source","version","observedAt"],"additionalProperties":false}},"required":["id","kind","source","observedAt","resource","summary","artifactRef","visibility","sensitivity","scope","provenance"],"additionalProperties":false}}}'::jsonb,now(),'migration-006') ON CONFLICT(id) DO UPDATE SET capability=EXCLUDED.capability,risk=EXCLUDED.risk,resource_types=EXCLUDED.resource_types,environment_policy=EXCLUDED.environment_policy,schemas=EXCLUDED.schemas;
INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas,reviewed_at,reviewed_by) VALUES('business.query',1,'approved','READ','READ','CUSTOMER','saas-api','business.inspect','LOW','["business"]'::jsonb,'["development","staging","production"]'::jsonb,'{}'::jsonb,now(),'migration-006') ON CONFLICT(id) DO UPDATE SET capability=EXCLUDED.capability,risk=EXCLUDED.risk,resource_types=EXCLUDED.resource_types,environment_policy=EXCLUDED.environment_policy,schemas=EXCLUDED.schemas;
INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas,reviewed_at,reviewed_by) VALUES('business.prepare',1,'approved','READ','PROPOSE','CUSTOMER','saas-bridge','business.propose','LOW','["business"]'::jsonb,'["development","staging","production"]'::jsonb,'{}'::jsonb,now(),'migration-006') ON CONFLICT(id) DO UPDATE SET capability=EXCLUDED.capability,risk=EXCLUDED.risk,resource_types=EXCLUDED.resource_types,environment_policy=EXCLUDED.environment_policy,schemas=EXCLUDED.schemas;
INSERT INTO control.tools(id,version,review,effect,stage,audience,provider,capability,risk,resource_types,environment_policy,schemas,reviewed_at,reviewed_by) VALUES('business.execute',1,'approved','WRITE','EXECUTE','CUSTOMER','saas-bridge','business.execute','MEDIUM','["business"]'::jsonb,'["development","staging","production"]'::jsonb,'{}'::jsonb,now(),'migration-006') ON CONFLICT(id) DO UPDATE SET capability=EXCLUDED.capability,risk=EXCLUDED.risk,resource_types=EXCLUDED.resource_types,environment_policy=EXCLUDED.environment_policy,schemas=EXCLUDED.schemas;

-- Upgrade preserves existing tool review/version/effect; a previously revoked tool stays revoked.
-- Backfill as the one-shot migrator: owner is subject to FORCE RLS and cannot see all tenants.
RESET ROLE;
ALTER TABLE core.runs ADD COLUMN provider_id text NOT NULL DEFAULT 'knowledge', ADD COLUMN capability text NOT NULL DEFAULT 'knowledge.search', ADD COLUMN input jsonb NOT NULL DEFAULT '{}';
UPDATE core.runs r SET input=jsonb_build_object('query',left(c.title,300),'limit',5) FROM core.cases c WHERE c.id=r.case_id;
ALTER TABLE core.run_steps DROP CONSTRAINT run_steps_name_check;
ALTER TABLE core.run_steps ADD COLUMN sequence bigserial, ADD COLUMN capability text,
 ADD COLUMN tool_id text, ADD COLUMN provider_id text, ADD COLUMN input_ref text, ADD COLUMN output_ref text,
 ADD COLUMN policy_decision text CHECK(policy_decision IN ('ALLOW','DENY','APPROVAL_REQUIRED'));
UPDATE core.run_steps s SET capability=CASE WHEN s.name='execution' THEN 'runtime.execute' ELSE s.name END,
 tool_id=CASE WHEN s.name='execution' THEN NULL ELSE r.tool_id END,provider_id=CASE WHEN s.name='execution' THEN NULL ELSE r.provider_id END,
 input_ref=CASE WHEN s.name='execution' THEN NULL ELSE 'run-input:'||r.id END,
 output_ref=CASE WHEN s.name<>'execution' AND s.state='succeeded' THEN 'run-evidence:'||r.id ELSE NULL END,
 policy_decision=CASE WHEN s.name='execution' OR s.state='started' THEN NULL WHEN s.state='succeeded' THEN 'ALLOW' ELSE 'DENY' END
 FROM core.runs r WHERE r.id=s.run_id;
-- Preserve deterministic ordering of historical 0.5 events with tied transaction timestamps.
WITH ordered AS (SELECT id,row_number() OVER(ORDER BY created_at,CASE WHEN name='execution' AND state='started' THEN 0 WHEN name<>'execution' AND state='started' THEN 1 WHEN name<>'execution' THEN 2 ELSE 3 END,id) AS n FROM core.run_steps)
UPDATE core.run_steps s SET sequence=o.n FROM ordered o WHERE s.id=o.id;
SELECT setval('core.run_steps_sequence_seq',GREATEST(1,(SELECT coalesce(max(sequence),0)+1 FROM core.run_steps)),false);
ALTER TABLE core.run_steps ALTER COLUMN capability SET NOT NULL;
ALTER SEQUENCE core.run_steps_sequence_seq OWNER TO agent18_owner;
GRANT USAGE,SELECT ON SEQUENCE core.run_steps_sequence_seq TO agent18_app;
ALTER TABLE core.audit DROP CONSTRAINT audit_decision_check;
ALTER TABLE core.audit ADD CONSTRAINT audit_decision_check CHECK(decision IN ('ALLOW','DENY','APPROVAL_REQUIRED'));
ALTER TABLE core.evidence ADD COLUMN payload jsonb;
UPDATE core.evidence SET payload=jsonb_build_object(
 'id',id,'kind','knowledge','source',citation->>'source','observedAt',citation->>'observedAt',
 'resource',jsonb_build_object('type','knowledge','id',citation->>'id'),'summary',citation->>'excerpt','artifactRef',null,
 'visibility','TENANT','sensitivity','CONFIDENTIAL',
 'scope',jsonb_build_object('organizationId',organization_id,'projectId',project_id,'tenantId',tenant_id,'subject',subject),
 'provenance',jsonb_build_object('providerId','knowledge','toolId','knowledge.search','toolVersion',1,'sourceVersion',citation->>'version','requestId','migration-006'),
 'citation',citation);
ALTER TABLE core.evidence ALTER COLUMN payload SET NOT NULL;
ALTER TABLE core.evidence ALTER COLUMN citation DROP NOT NULL;
ALTER TABLE core.evidence ADD CONSTRAINT evidence_payload_identity CHECK((payload->>'id'=id::text AND payload->'scope'->>'organizationId'=organization_id::text AND payload->'scope'->>'projectId'=project_id::text AND payload->'scope'->>'tenantId'=tenant_id AND payload->'scope'->>'subject'=subject) IS TRUE);
RESET ROLE;
