package agent18.gateway_test
import rego.v1
import data.agent18.gateway.decision
fixture := {"principal":{"kind":"customer","scope":{"tenantId":"a"}},"action":{"id":"arbitrary.lookup","version":7,"review":"approved","capability":"logs.search","effect":"READ","stage":"READ","risk":"LOW","audience":"CUSTOMER","resourceTypes":["log"],"environmentPolicy":["production"]},"resource":{"type":"log","visibility":"TENANT","scope":{"tenantId":"a"}},"context":{"scopeValid":true,"capabilityValid":true,"registered":true,"environment":"production","phase":"case","userConfirmed":false}}
test_generic_reviewed_read if { decision.decision == "ALLOW" with input as fixture }
test_missing_denied if { decision.decision == "DENY" with input as {} }
test_wrong_scope_denied if { decision.decision == "DENY" with input as object.union(fixture,{"resource":object.union(fixture.resource,{"scope":{"tenantId":"b"}})}) }
test_expired_denied if { decision.decision == "DENY" with input as object.union(fixture,{"context":object.union(fixture.context,{"capabilityValid":false})}) }
test_unregistered_denied if { decision.decision == "DENY" with input as object.union(fixture,{"context":object.union(fixture.context,{"registered":false})}) }
test_unreviewed_denied if { decision.decision == "DENY" with input as object.union(fixture,{"action":object.union(fixture.action,{"review":"pending"})}) }
test_revoked_denied if { decision.decision == "DENY" with input as object.union(fixture,{"action":object.union(fixture.action,{"review":"revoked"})}) }
test_environment_denied if { decision.decision == "DENY" with input as object.union(fixture,{"context":object.union(fixture.context,{"environment":"other"})}) }
test_resource_denied if { decision.decision == "DENY" with input as object.union(fixture,{"resource":object.union(fixture.resource,{"type":"source"})}) }
test_customer_internal_denied if { decision.decision == "DENY" with input as object.union(fixture,{"resource":object.union(fixture.resource,{"visibility":"INTERNAL"})}) }
test_customer_engineering_denied if { decision.decision == "DENY" with input as object.union(fixture,{"action":object.union(fixture.action,{"audience":"ENGINEERING"})}) }
write := object.union(fixture,{"action":object.union(fixture.action,{"effect":"WRITE","stage":"EXECUTE","risk":"MEDIUM"}),"context":object.union(fixture.context,{"phase":"support"})})
test_write_requires_confirmation if { decision.decision == "APPROVAL_REQUIRED" with input as write }
test_confirmed_write_allowed if { decision.decision == "ALLOW" with input as object.union(write,{"context":object.union(write.context,{"userConfirmed":true})}) }
test_high_risk_requires_verified_approval if { decision.decision == "APPROVAL_REQUIRED" with input as object.union(fixture,{"action":object.union(fixture.action,{"risk":"HIGH"}),"context":object.union(fixture.context,{"approval":{"id":"forged","valid":false}})}) }
test_run_write_denied if { decision.decision == "DENY" with input as object.union(write,{"context":object.union(write.context,{"phase":"case","userConfirmed":true})}) }
