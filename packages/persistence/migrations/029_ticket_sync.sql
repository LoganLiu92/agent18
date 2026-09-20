SET ROLE agent18_owner;
CREATE TABLE control.external_ticket_links(
 case_id uuid PRIMARY KEY,organization_id uuid NOT NULL,project_id uuid NOT NULL,tenant_id text NOT NULL,
 operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),config_hash text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,external_id text,external_version int NOT NULL DEFAULT 0,external_status text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(case_id,organization_id,project_id) REFERENCES core.cases(id,organization_id,project_id)
);
CREATE TABLE control.ticket_outbox(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),case_id uuid NOT NULL REFERENCES control.external_ticket_links(case_id),case_version int NOT NULL,
 organization_id uuid NOT NULL,project_id uuid NOT NULL,tenant_id text NOT NULL,config_hash text NOT NULL,payload jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','delivered','failed','cancelled')),attempts int NOT NULL DEFAULT 0,
 lease_id uuid,lease_until timestamptz,next_attempt timestamptz NOT NULL DEFAULT now(),reason text,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
 UNIQUE(case_id,case_version)
);
CREATE TABLE control.ticket_inbox(
 id uuid PRIMARY KEY,case_id uuid NOT NULL REFERENCES control.external_ticket_links(case_id),payload_hash text NOT NULL,
 version int NOT NULL,outcome text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON control.external_ticket_links,control.ticket_outbox TO agent18_app;
GRANT SELECT,INSERT ON control.ticket_inbox TO agent18_app;
CREATE INDEX ticket_outbox_due ON control.ticket_outbox(state,next_attempt,created_at);
CREATE FUNCTION core.enqueue_ticket_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link control.external_ticket_links%ROWTYPE;
BEGIN
 SELECT * INTO link FROM control.external_ticket_links WHERE case_id=NEW.id AND enabled;
 IF FOUND THEN
  INSERT INTO control.ticket_outbox(case_id,case_version,organization_id,project_id,tenant_id,config_hash,payload)
  VALUES(NEW.id,NEW.ticket_version,NEW.organization_id,NEW.project_id,NEW.tenant_id,link.config_hash,
   jsonb_build_object('origin','agent18','ticketId',NEW.id,'version',NEW.ticket_version,'status',NEW.ticket_status,'priority',NEW.priority,'deleted',NEW.deleted_at IS NOT NULL)) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ticket_sync_outbox AFTER UPDATE ON core.cases FOR EACH ROW EXECUTE FUNCTION core.enqueue_ticket_sync();
RESET ROLE;
