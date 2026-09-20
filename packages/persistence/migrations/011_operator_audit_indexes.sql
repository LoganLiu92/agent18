SET ROLE agent18_owner;
CREATE INDEX operator_audit_page ON control.operator_audit(created_at DESC,id DESC);
CREATE INDEX operator_audit_action_page ON control.operator_audit(action,created_at DESC,id DESC);
CREATE INDEX operator_audit_target_page ON control.operator_audit(target_id,created_at DESC,id DESC);
RESET ROLE;
