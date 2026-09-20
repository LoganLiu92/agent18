// Run only against the isolated restore target, before it is eligible for activation.
// Old backups without the operator schema remain supported.
export const revokeRestoredOperatorSessions = `DO $restore$
BEGIN
  IF to_regclass('control.operator_sessions') IS NOT NULL THEN
    DELETE FROM control.operator_sessions;
    INSERT INTO control.operator_audit(id,actor_id,action,target_id,request_id)
      VALUES(gen_random_uuid(),NULL,'operator.restore.sessions_revoked',NULL,'restore-maintenance');
  END IF;
END
$restore$;`;
