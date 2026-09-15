CREATE SCHEMA core AUTHORIZATION agent18_owner;
CREATE SCHEMA control AUTHORIZATION agent18_owner;
SET ROLE agent18_owner;

CREATE TABLE core.organizations (id uuid PRIMARY KEY, display_name text NOT NULL);
CREATE TABLE core.projects (organization_id uuid NOT NULL REFERENCES core.organizations(id), id uuid NOT NULL, project_key text UNIQUE NOT NULL, display_name text NOT NULL, PRIMARY KEY (organization_id, id));
CREATE TABLE core.tenants (
  organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL,
  display_name text NOT NULL, PRIMARY KEY (organization_id, project_id, tenant_id),
  FOREIGN KEY (organization_id, project_id) REFERENCES core.projects(organization_id, id)
);
CREATE TABLE core.cases (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL,
  subject text NOT NULL, title text NOT NULL, description text NOT NULL, context jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'needs_human')),
  idempotency_key uuid NOT NULL, request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id, tenant_id) REFERENCES core.tenants,
  UNIQUE (organization_id, project_id, tenant_id, subject, idempotency_key),
  UNIQUE (id, organization_id, project_id, tenant_id, subject)
);
CREATE TABLE core.runs (
  id uuid PRIMARY KEY, case_id uuid NOT NULL, organization_id uuid NOT NULL, project_id uuid NOT NULL,
  tenant_id text NOT NULL, subject text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'blocked')),
  outcome text, capability_id uuid NOT NULL, tool_id text NOT NULL, tool_version int NOT NULL,
  scope_revision int NOT NULL DEFAULT 1, capability_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  FOREIGN KEY (case_id, organization_id, project_id, tenant_id, subject) REFERENCES core.cases(id, organization_id, project_id, tenant_id, subject),
  UNIQUE (id, case_id, organization_id, project_id, tenant_id, subject)
);
CREATE TABLE core.evidence (
  id uuid PRIMARY KEY, run_id uuid NOT NULL, case_id uuid NOT NULL, organization_id uuid NOT NULL,
  project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL, citation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, case_id, organization_id, project_id, tenant_id, subject) REFERENCES core.runs(id, case_id, organization_id, project_id, tenant_id, subject)
);
CREATE TABLE core.audit (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL, tenant_id text NOT NULL,
  subject text NOT NULL, case_id uuid, request_id text NOT NULL, action text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ALLOW', 'DENY')), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (case_id, organization_id, project_id, tenant_id, subject) REFERENCES core.cases(id, organization_id, project_id, tenant_id, subject)
);
CREATE INDEX cases_scope_created ON core.cases(organization_id, project_id, tenant_id, subject, created_at DESC);
CREATE INDEX evidence_case ON core.evidence(case_id);
CREATE INDEX audit_case ON core.audit(case_id, created_at DESC);
CREATE INDEX runs_case ON core.runs(case_id);

-- These control tables contain routing/security metadata, not Case text, evidence or credentials.
CREATE TABLE control.dispatch (
  id uuid PRIMARY KEY, run_id uuid NOT NULL UNIQUE, organization_id uuid NOT NULL, project_id uuid NOT NULL,
  tenant_id text NOT NULL, subject text NOT NULL, job_id uuid, delivered_at timestamptz,
  lease_hash text, lease_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id) REFERENCES core.runs(id)
);
CREATE TABLE control.tools (
  id text PRIMARY KEY, version int NOT NULL, review text NOT NULL, effect text NOT NULL,
  stage text NOT NULL, audience text NOT NULL, provider text NOT NULL
);
CREATE TABLE control.security_events (
  id uuid PRIMARY KEY, request_id text NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Placeholders are deliberately absent: approval and secret stores are not implemented in M0.

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','cases','runs','evidence','audit'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY scope_isolation ON core.%I USING (organization_id = nullif(current_setting(''agent18.organization_id'', true), '''')::uuid AND project_id = nullif(current_setting(''agent18.project_id'', true), '''')::uuid AND tenant_id = current_setting(''agent18.tenant_id'', true)%s) WITH CHECK (organization_id = nullif(current_setting(''agent18.organization_id'', true), '''')::uuid AND project_id = nullif(current_setting(''agent18.project_id'', true), '''')::uuid AND tenant_id = current_setting(''agent18.tenant_id'', true)%s)', t,
      CASE WHEN t = 'tenants' THEN '' ELSE ' AND subject = current_setting(''agent18.subject'', true)' END,
      CASE WHEN t = 'tenants' THEN '' ELSE ' AND subject = current_setting(''agent18.subject'', true)' END);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA core, control TO agent18_app;
GRANT SELECT ON core.tenants TO agent18_app;
GRANT SELECT, INSERT, UPDATE ON core.cases, core.runs TO agent18_app;
GRANT SELECT, INSERT ON core.evidence, core.audit TO agent18_app;
GRANT SELECT, INSERT, UPDATE ON control.dispatch TO agent18_app;
GRANT SELECT ON control.tools TO agent18_app;
GRANT INSERT ON control.security_events TO agent18_app;
REVOKE ALL ON SCHEMA core, control FROM PUBLIC;
RESET ROLE;

INSERT INTO core.organizations VALUES ('00000000-0000-4000-8000-000000000018', 'agent18 Demo SaaS');
INSERT INTO core.projects VALUES
 ('00000000-0000-4000-8000-000000000018','10000000-0000-4000-8000-000000000018','invoice-demo','Invoice SaaS'),
 ('00000000-0000-4000-8000-000000000018','20000000-0000-4000-8000-000000000018','other-demo','Other SaaS');
INSERT INTO core.tenants VALUES
 ('00000000-0000-4000-8000-000000000018','10000000-0000-4000-8000-000000000018','tenant-a','Aurora Studio'),
 ('00000000-0000-4000-8000-000000000018','10000000-0000-4000-8000-000000000018','tenant-b','Northwind Labs'),
 ('00000000-0000-4000-8000-000000000018','20000000-0000-4000-8000-000000000018','tenant-a','Aurora · Other Project');
INSERT INTO control.tools VALUES ('knowledge.search', 1, 'approved', 'READ', 'READ', 'CUSTOMER', 'knowledge-fixture');
