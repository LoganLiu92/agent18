SET ROLE agent18_owner;
ALTER TABLE control.support_settings ADD COLUMN calendar jsonb;
ALTER TABLE core.cases ADD COLUMN sla_calendar jsonb;
CREATE FUNCTION core.sla_seconds(start_at timestamptz,end_at timestamptz,calendar jsonb) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN start_at IS NULL OR end_at<=start_at THEN 0
 WHEN calendar IS NULL THEN greatest(0,extract(epoch FROM(end_at-start_at)))
 ELSE coalesce((SELECT sum(greatest(0,extract(epoch FROM (least(end_at,(d::date+(calendar->>'end')::time) AT TIME ZONE (calendar->>'timezone'))-greatest(start_at,(d::date+(calendar->>'start')::time) AT TIME ZONE (calendar->>'timezone'))))))
 FROM generate_series((start_at AT TIME ZONE (calendar->>'timezone'))::date::timestamp,(end_at AT TIME ZONE (calendar->>'timezone'))::date::timestamp,interval '1 day') d
 WHERE (calendar->'weekdays') @> to_jsonb(extract(isodow FROM d)::int) AND NOT (calendar->'holidays') ? (d::date::text)),0) END;
$$;
REVOKE ALL ON FUNCTION core.sla_seconds(timestamptz,timestamptz,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.sla_seconds(timestamptz,timestamptz,jsonb) TO agent18_app;
CREATE OR REPLACE FUNCTION core.ticket_followup() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings control.support_settings%ROWTYPE;
BEGIN
 SELECT * INTO settings FROM control.support_settings WHERE organization_id=NEW.organization_id AND project_id=NEW.project_id;
 IF TG_OP='INSERT' THEN
  IF settings.enabled THEN NEW.sla_calendar:=settings.calendar; NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int; NEW.sla_clock_started_at:=now(); END IF;
 ELSE
  IF NEW.sla_target_minutes IS NULL AND settings.enabled THEN
   NEW.sla_calendar:=settings.calendar; NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int;
   IF NEW.ticket_status IN ('new','open','investigating') THEN NEW.sla_clock_started_at:=now(); END IF;
  END IF;
  IF OLD.sla_target_minutes IS NOT NULL AND OLD.priority IS DISTINCT FROM NEW.priority AND settings.enabled THEN NEW.sla_target_minutes:=(settings.targets->>NEW.priority)::int; END IF;
  IF NEW.ticket_status IS DISTINCT FROM OLD.ticket_status THEN
   IF OLD.sla_clock_started_at IS NOT NULL THEN NEW.sla_elapsed_seconds:=OLD.sla_elapsed_seconds+core.sla_seconds(OLD.sla_clock_started_at,now(),OLD.sla_calendar); END IF;
   NEW.sla_clock_started_at:=CASE WHEN NEW.sla_target_minutes IS NOT NULL AND NEW.ticket_status IN ('new','open','investigating') THEN now() ELSE NULL END;
   IF OLD.ticket_status IN ('resolved','closed') AND NEW.ticket_status NOT IN ('resolved','closed') THEN
    INSERT INTO knowledge.case_review_signals(case_id,case_version,organization_id,project_id) VALUES(NEW.id,NEW.ticket_version,NEW.organization_id,NEW.project_id);
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
RESET ROLE;
