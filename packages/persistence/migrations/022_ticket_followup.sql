SET ROLE agent18_owner;
CREATE TABLE control.support_settings (
 organization_id uuid NOT NULL,project_id uuid NOT NULL,enabled boolean NOT NULL DEFAULT false,
 targets jsonb NOT NULL DEFAULT '{"low":4320,"normal":1440,"high":240,"urgent":60}',
 updated_by uuid NOT NULL REFERENCES control.operator_accounts(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,project_id),FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
GRANT SELECT,INSERT,UPDATE ON control.support_settings TO agent18_app;
ALTER TABLE core.cases ADD COLUMN sla_target_minutes int CHECK(sla_target_minutes>0),
 ADD COLUMN sla_elapsed_seconds numeric NOT NULL DEFAULT 0,
 ADD COLUMN sla_clock_started_at timestamptz, ADD COLUMN first_response_at timestamptz;
CREATE TABLE control.ticket_notification_reads (
 operator_id uuid NOT NULL REFERENCES control.operator_accounts(id),case_id uuid NOT NULL REFERENCES core.cases(id),
 version int NOT NULL,read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(operator_id,case_id)
);
GRANT SELECT,INSERT,UPDATE ON control.ticket_notification_reads TO agent18_app;
CREATE TABLE knowledge.case_review_signals (
 case_id uuid NOT NULL,case_version int NOT NULL,organization_id uuid NOT NULL,project_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(case_id,case_version),
 FOREIGN KEY(case_id,organization_id,project_id) REFERENCES core.cases(id,organization_id,project_id)
);
ALTER TABLE knowledge.case_review_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.case_review_signals FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON knowledge.case_review_signals FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY scope_insert ON knowledge.case_review_signals FOR INSERT TO agent18_app WITH CHECK(
 EXISTS(SELECT 1 FROM core.cases c WHERE c.id=case_id AND c.organization_id=case_review_signals.organization_id AND c.project_id=case_review_signals.project_id));
GRANT SELECT,INSERT ON knowledge.case_review_signals TO agent18_app;
ALTER TABLE knowledge.documents ADD COLUMN case_review_ack_version int NOT NULL DEFAULT 0;
CREATE FUNCTION core.ticket_followup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings control.support_settings%ROWTYPE;
BEGIN
 SELECT * INTO settings FROM control.support_settings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id;
 IF TG_OP='INSERT' THEN
  IF settings.enabled THEN NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int; NEW.sla_clock_started_at:=now(); END IF;
 ELSE
  IF NEW.sla_target_minutes IS NULL AND settings.enabled THEN
   NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int;
   IF NEW.ticket_status IN ('new','open','investigating') THEN NEW.sla_clock_started_at:=now(); END IF;
  END IF;
  IF OLD.sla_target_minutes IS NOT NULL AND OLD.priority IS DISTINCT FROM NEW.priority AND settings.enabled THEN NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int; END IF;
  IF NEW.ticket_status IS DISTINCT FROM OLD.ticket_status THEN
   IF OLD.sla_clock_started_at IS NOT NULL THEN NEW.sla_elapsed_seconds:=OLD.sla_elapsed_seconds+greatest(0,extract(epoch FROM (now()-OLD.sla_clock_started_at))); END IF;
   NEW.sla_clock_started_at:=CASE WHEN NEW.sla_target_minutes IS NOT NULL AND NEW.ticket_status IN ('new','open','investigating') THEN now() ELSE NULL END;
   IF OLD.ticket_status IN ('resolved','closed') AND NEW.ticket_status NOT IN ('resolved','closed') THEN
    INSERT INTO knowledge.case_review_signals(case_id,case_version,organization_id,project_id) VALUES(NEW.id,NEW.ticket_version,NEW.organization_id,NEW.project_id);
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- Alphabetical trigger ordering: status/version normalization runs before follow-up clocks.
CREATE TRIGGER z_ticket_followup BEFORE INSERT OR UPDATE ON core.cases FOR EACH ROW EXECUTE FUNCTION core.ticket_followup();
RESET ROLE;
