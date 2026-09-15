package agent18.gateway
import rego.v1

default decision := {"decision": "DENY", "reason": "POLICY_DENIED"}

base if {
  input.principal.scope == input.resource.scope
  input.context.scopeValid == true
  input.context.capabilityValid == true
  input.context.registered == true
  is_boolean(input.context.userConfirmed)
  input.context.phase in {"support", "case"}
  input.action.review == "approved"
  input.action.version > 0
  input.action.risk in {"LOW", "MEDIUM", "HIGH"}
  input.resource.type in input.action.resourceTypes
  input.context.environment in input.action.environmentPolicy
  audience_allowed
  valid_stage
}
audience_allowed if {
  input.principal.kind == "customer"
  input.action.audience == "CUSTOMER"
  input.resource.visibility in {"PUBLIC", "TENANT"}
}
audience_allowed if {
  input.principal.kind == "operator"
  input.action.audience == "ENGINEERING"
  sprintf("tool:%s:%s", [input.action.id,input.action.stage]) in input.principal.permissions
}
valid_stage if { input.action.effect == "READ"; input.action.stage in {"READ", "PROPOSE"} }
valid_stage if { input.action.effect == "WRITE"; input.action.stage == "EXECUTE"; input.context.phase == "support" }
needs_approval if { input.action.effect == "WRITE"; input.context.userConfirmed != true }
needs_approval if { input.action.risk == "HIGH"; not verified_approval }
verified_approval if { input.context.approval.valid == true; count(input.context.approval.id) > 0 }
decision := {"decision": "APPROVAL_REQUIRED", "reason": "HUMAN_APPROVAL_REQUIRED"} if { base; needs_approval }
decision := {"decision": "ALLOW", "reason": "REGISTERED_CAPABILITY_APPROVED"} if { base; not needs_approval }
