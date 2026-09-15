package agent18.gateway

import rego.v1

default allow := false

allow if {
  input.principal.kind == "customer"
  input.principal.scope == input.scope
  input.scopeValid == true
  input.capabilityValid == true
  input.phase in {"support", "case"}
  input.tool.id == "knowledge.search"
  input.tool.version == 1
  input.tool.review == "approved"
  input.tool.effect == "READ"
  input.tool.stage == "READ"
  input.tool.audience == "CUSTOMER"
  input.tool.provider == "knowledge-fixture"
}


allow if {
  input.principal.kind == "customer"
  input.principal.scope == input.scope
  input.scopeValid == true
  input.capabilityValid == true
  input.phase == "support"
  input.tool.id == "business.delegate"
  input.tool.version == 1
  input.tool.review == "approved"
  input.tool.audience == "CUSTOMER"
  input.tool.provider == "saas-bridge"
  input.actionRegistered == true
  input.tool.effect == "READ"
  input.tool.stage == "PROPOSE"
}

allow if {
  input.principal.kind == "customer"
  input.principal.scope == input.scope
  input.scopeValid == true
  input.capabilityValid == true
  input.phase == "support"
  input.tool.id == "business.delegate"
  input.tool.version == 1
  input.tool.review == "approved"
  input.tool.audience == "CUSTOMER"
  input.tool.provider == "saas-bridge"
  input.actionRegistered == true
  input.userConfirmed == true
  input.tool.effect == "WRITE"
  input.tool.stage == "EXECUTE"
}

allow if {
  input.principal.kind == "customer"
  input.principal.scope == input.scope
  input.scopeValid == true
  input.capabilityValid == true
  input.phase == "support"
  input.tool.id == "business.query"
  input.tool.version == 1
  input.tool.review == "approved"
  input.tool.audience == "CUSTOMER"
  input.tool.provider == "saas-api"
  input.actionRegistered == true
  input.tool.effect == "READ"
  input.tool.stage == "READ"
}
