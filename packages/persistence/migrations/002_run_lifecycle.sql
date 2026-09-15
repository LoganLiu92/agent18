SET ROLE agent18_owner;

ALTER TABLE core.runs DROP CONSTRAINT runs_state_check;
ALTER TABLE core.runs ADD CONSTRAINT runs_state_check CHECK (state IN ('pending','running','completed','blocked','cancelled','failed'));
ALTER TABLE core.runs
  ADD COLUMN attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN max_attempts int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN execution_budget_ms int NOT NULL DEFAULT 5000 CHECK (execution_budget_ms BETWEEN 100 AND 30000),
  ADD COLUMN last_started_at timestamptz,
  ADD COLUMN retry_of uuid UNIQUE REFERENCES core.runs(id),
  ADD COLUMN retry_key uuid;
ALTER TABLE core.runs ADD CONSTRAINT retry_same_case_scope FOREIGN KEY (retry_of,case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.runs(id,case_id,organization_id,project_id,tenant_id,subject);
CREATE UNIQUE INDEX one_active_run_per_case ON core.runs(case_id) WHERE state IN ('pending','running');
CREATE UNIQUE INDEX run_retry_key ON core.runs(organization_id,project_id,tenant_id,subject,retry_key) WHERE retry_key IS NOT NULL;

CREATE TABLE core.run_steps (
  id uuid PRIMARY KEY, run_id uuid NOT NULL, case_id uuid NOT NULL, organization_id uuid NOT NULL,
  project_id uuid NOT NULL, tenant_id text NOT NULL, subject text NOT NULL,
  attempt int NOT NULL CHECK (attempt >= 0), name text NOT NULL CHECK (name IN ('execution','knowledge.search')),
  state text NOT NULL CHECK (state IN ('started','succeeded','failed','cancelled','interrupted')),
  reason text NOT NULL, duration_ms int CHECK (duration_ms >= 0), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id,case_id,organization_id,project_id,tenant_id,subject) REFERENCES core.runs(id,case_id,organization_id,project_id,tenant_id,subject)
);
CREATE INDEX run_steps_run ON core.run_steps(run_id,created_at);
ALTER TABLE core.run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_isolation ON core.run_steps USING (
  organization_id = nullif(current_setting('agent18.organization_id',true),'')::uuid
  AND project_id = nullif(current_setting('agent18.project_id',true),'')::uuid
  AND tenant_id = current_setting('agent18.tenant_id',true)
  AND subject = current_setting('agent18.subject',true)
);
GRANT SELECT,INSERT ON core.run_steps TO agent18_app;
ALTER TABLE control.dispatch ADD COLUMN settled_at timestamptz, ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX dispatch_reconcile ON control.dispatch(next_check_at) WHERE settled_at IS NULL AND delivered_at IS NOT NULL;
RESET ROLE;
