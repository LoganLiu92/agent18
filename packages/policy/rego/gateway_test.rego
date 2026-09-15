package agent18.gateway_test

import rego.v1
import data.agent18.gateway.allow

fixture := {"principal": {"kind": "customer", "scope": {"tenantId": "a"}}, "scope": {"tenantId": "a"}, "scopeValid": true, "capabilityValid": true, "phase": "case", "tool": {"id": "knowledge.search", "version": 1, "review": "approved", "effect": "READ", "stage": "READ", "audience": "CUSTOMER", "provider": "knowledge-fixture"}}
test_approved_read if { allow with input as fixture }
test_missing_input_denied if { not allow with input as {} }
test_write_denied if { not allow with input as object.union(fixture, {"tool": object.union(fixture.tool, {"effect": "WRITE"})}) }
test_scope_mismatch_denied if { not allow with input as object.union(fixture, {"scope": {"tenantId": "b"}}) }
test_unreviewed_denied if { not allow with input as object.union(fixture, {"tool": object.union(fixture.tool, {"review": "pending"})}) }
test_expired_capability_denied if { not allow with input as object.union(fixture, {"capabilityValid": false}) }

delegated := object.union(fixture, {"phase":"support","actionRegistered":true,"userConfirmed":true,"tool":{"id":"business.delegate","version":1,"review":"approved","effect":"WRITE","stage":"EXECUTE","audience":"CUSTOMER","provider":"saas-bridge"}})
test_confirmed_delegate_allowed if { allow with input as delegated }
test_delegate_without_confirmation_denied if { not allow with input as object.union(delegated,{"userConfirmed":false}) }
test_delegate_unregistered_denied if { not allow with input as object.union(delegated,{"actionRegistered":false}) }
test_delegate_expired_denied if { not allow with input as object.union(delegated,{"scopeValid":false}) }
test_delegate_cross_scope_denied if { not allow with input as object.union(delegated,{"scope":{"tenantId":"other"}}) }
test_delegate_preview_allowed if { allow with input as object.union(delegated,{"userConfirmed":false,"tool":object.union(delegated.tool,{"effect":"READ","stage":"PROPOSE"})}) }
