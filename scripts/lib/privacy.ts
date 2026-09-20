import { z } from 'zod';
import { randomBytes } from 'node:crypto';
export const tombstoneSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  project_id: z.string().uuid(),
  tenant_id: z.string(),
  subject: z.string(),
  resource_type: z.enum(['conversation', 'ticket', 'attachment', 'runtime_evidence', 'insight', 'audit']),
  resource_id: z.string().uuid(),
  created_at: z.string(),
});
export type Tombstone = z.infer<typeof tombstoneSchema>;
/** Privileged maintenance only: fixed SQL and validated data, usable in isolated restores. */
export function privacyReplaySql(raw: unknown) {
  const rows = z.array(tombstoneSchema).parse(raw);
  const json = JSON.stringify(rows).replaceAll("'", "''");
  let delimiter: string;
  do {
    delimiter = '$privacy_' + randomBytes(16).toString('hex') + '$';
  } while (json.includes(delimiter));
  return `DO ${delimiter} DECLARE item jsonb; target uuid; BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements('${json}'::jsonb) LOOP
 target:=(item->>'resource_id')::uuid;
 IF item->>'resource_type'='conversation' AND to_regclass('core.conversations') IS NOT NULL THEN
  UPDATE core.conversations SET title='已删除',deleted_at=coalesce(deleted_at,now()) WHERE id=target;
  UPDATE core.conversation_messages SET body='' WHERE conversation_id=target;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core' AND table_name='conversation_messages' AND column_name='result_refs') THEN UPDATE core.conversation_messages SET result_refs='[]' WHERE conversation_id=target; END IF;
  DELETE FROM core.conversation_cases WHERE conversation_id=target;
 ELSIF item->>'resource_type'='insight' AND to_regclass('control.insight_reports') IS NOT NULL THEN
  DELETE FROM control.insight_reports WHERE id=target;
  IF to_regclass('control.automation_jobs') IS NOT NULL THEN UPDATE control.automation_jobs SET state='cancelled',reason='PRIVACY_ERASURE',lease_until=NULL WHERE id=target; END IF;
 ELSIF item->>'resource_type'='audit' THEN
  DELETE FROM core.audit WHERE id=target;
 ELSIF item->>'resource_type' IN ('attachment','runtime_evidence','ticket') THEN
  IF to_regclass('core.case_captures') IS NOT NULL THEN DELETE FROM core.case_captures WHERE case_id=target; END IF;
  IF to_regclass('control.observation_jobs') IS NOT NULL THEN
   UPDATE control.observation_jobs SET state='cancelled',reason='PRIVACY_ERASURE',lease_until=NULL WHERE case_id=target AND state IN ('pending','running');
   DELETE FROM core.observation_reports WHERE job_id IN (SELECT id FROM control.observation_jobs WHERE case_id=target);
  END IF;
  IF item->>'resource_type' IN ('runtime_evidence','ticket') THEN
   DELETE FROM core.evidence WHERE case_id=target;
   IF to_regclass('core.run_steps') IS NOT NULL THEN DELETE FROM core.run_steps WHERE run_id IN (SELECT id FROM core.runs WHERE case_id=target); END IF;
  END IF;
  IF item->>'resource_type'='ticket' THEN
   IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core' AND table_name='cases' AND column_name='deleted_at') THEN
    UPDATE core.cases SET title='已删除',description='',context='{}',resolution=NULL,public_resolution=NULL,deleted_at=coalesce(deleted_at,now()) WHERE id=target;
   ELSE
    RAISE EXCEPTION 'RESTORE_REQUIRES_PRIVACY_MIGRATION';
   END IF;
   UPDATE core.case_messages SET body='[已删除]' WHERE case_id=target;
   IF to_regclass('core.ticket_notes') IS NOT NULL THEN UPDATE core.ticket_notes SET body='[已删除]' WHERE case_id=target; UPDATE core.ticket_events SET detail='{}' WHERE case_id=target; END IF;
   UPDATE core.runs SET input='{}',outcome='PRIVACY_ERASURE',state=CASE WHEN state IN ('pending','running') THEN 'cancelled' ELSE state END WHERE case_id=target;
   IF to_regclass('core.conversation_cases') IS NOT NULL THEN DELETE FROM core.conversation_cases WHERE case_id=target; END IF;
  END IF;
 END IF;
 IF to_regclass('control.privacy_tombstones') IS NOT NULL THEN
 INSERT INTO control.privacy_tombstones(id,organization_id,project_id,tenant_id,subject,resource_type,resource_id,created_at)
 VALUES((item->>'id')::uuid,(item->>'organization_id')::uuid,(item->>'project_id')::uuid,item->>'tenant_id',item->>'subject',item->>'resource_type',target,(item->>'created_at')::timestamptz) ON CONFLICT DO NOTHING;
 ELSIF item->>'resource_type' NOT IN ('conversation','insight') THEN
 RAISE EXCEPTION 'RESTORE_REQUIRES_PRIVACY_MIGRATION';
 END IF;
 END LOOP; END ${delimiter};`;
}
