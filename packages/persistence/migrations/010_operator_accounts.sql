-- Independent Agent18 staff accounts. These are not customer principals or business credentials.
SET ROLE agent18_owner;
CREATE TABLE control.operator_accounts (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE,
 display_name text NOT NULL, password_hash text NOT NULL,
 administrator boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true,
 must_change_password boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE control.operator_memberships (
 operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 organization_id uuid NOT NULL, project_id uuid NOT NULL,
 roles text[] NOT NULL,
 PRIMARY KEY(operator_id,organization_id,project_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id),
 CHECK(cardinality(roles)>0 AND roles <@ ARRAY['viewer','support','engineer','knowledge_editor','knowledge_publisher']::text[])
);
CREATE TABLE control.operator_sessions (
 token_hash text PRIMARY KEY, operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operator_session_account ON control.operator_sessions(operator_id);
CREATE TABLE control.operator_login_limits (
 key text PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), count int NOT NULL
);
CREATE TABLE control.operator_audit (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES control.operator_accounts(id),
 action text NOT NULL, target_id text, request_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON control.operator_accounts TO agent18_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON control.operator_memberships,control.operator_sessions,control.operator_login_limits TO agent18_app;
GRANT SELECT,INSERT ON control.operator_audit TO agent18_app;
RESET ROLE;
