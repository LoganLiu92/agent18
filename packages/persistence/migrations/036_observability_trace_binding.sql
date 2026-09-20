-- Upgrade only the bundled binding. Retain approval/revocation decisions and historical evidence.
-- Modified installations fail closed and require an explicit registry review.
SET ROLE agent18_owner;
DO $$ BEGIN
 IF EXISTS (
  SELECT 1 FROM control.tools t JOIN control.providers p ON p.id=t.provider
  WHERE t.id='operations.observe' AND t.version=1 AND t.provider='observability'
   AND t.capability='operations.observe' AND t.effect='READ' AND t.stage='READ'
   AND t.audience='ENGINEERING' AND t.risk='LOW'
   AND t.resource_types='["log","metric","health"]'::jsonb
   AND t.environment_policy='["development","staging","production"]'::jsonb
   AND t.reviewed_by='migration-009'
   AND p.version='1.0.0' AND p.transport='http'
   AND p.capabilities='["operations.observe"]'::jsonb AND p.reviewed_by='migration-009'
 ) THEN
  UPDATE control.providers SET version='1.1.0' WHERE id='observability';
  UPDATE control.tools SET version=2,resource_types='["log","metric","health","trace"]'::jsonb
   WHERE id='operations.observe';
 END IF;
END $$;
RESET ROLE;
