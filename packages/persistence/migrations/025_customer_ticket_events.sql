SET ROLE agent18_owner;
CREATE POLICY customer_event_insert ON core.ticket_events FOR INSERT TO agent18_app WITH CHECK(
 organization_id=nullif(current_setting('agent18.organization_id',true),'')::uuid AND project_id=nullif(current_setting('agent18.project_id',true),'')::uuid
 AND tenant_id=current_setting('agent18.tenant_id',true) AND subject=current_setting('agent18.subject',true)
 AND operator_id IS NULL AND action IN ('customer.status','customer.message','owner.message','customer.capture.delete'));
RESET ROLE;
