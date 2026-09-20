SET ROLE agent18_owner;
ALTER TABLE control.support_settings ADD COLUMN response_targets jsonb NOT NULL DEFAULT '{"low":480,"normal":240,"high":60,"urgent":15}';
ALTER TABLE core.cases ADD COLUMN first_response_started_at timestamptz, ADD COLUMN first_response_target_minutes int CHECK(first_response_target_minutes>0);
CREATE FUNCTION core.ticket_response_clock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings control.support_settings%ROWTYPE;
BEGIN
 SELECT * INTO settings FROM control.support_settings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id;
 IF NEW.first_response_started_at IS NULL AND NEW.first_response_at IS NULL AND settings.enabled AND NEW.ticket_status NOT IN ('resolved','closed') THEN
  NEW.first_response_started_at:=now();NEW.first_response_target_minutes:=(settings.response_targets->>NEW.priority)::int;
 END IF;
 IF TG_OP='UPDATE' AND OLD.priority IS DISTINCT FROM NEW.priority AND NEW.first_response_at IS NULL AND NEW.first_response_started_at IS NOT NULL AND settings.enabled THEN
  NEW.first_response_target_minutes:=(settings.response_targets->>NEW.priority)::int;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ticket_response_clock BEFORE INSERT OR UPDATE ON core.cases FOR EACH ROW EXECUTE FUNCTION core.ticket_response_clock();
RESET ROLE;
