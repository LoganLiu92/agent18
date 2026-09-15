-- A failed provider call is not proof of an OPA denial. Legacy 0.5 steps lack
-- an exact policy result, so retain unknown rather than infer DENY from failure.
UPDATE core.run_steps SET policy_decision=NULL
WHERE state IN ('failed','cancelled','interrupted')
  AND created_at <= (SELECT applied_at FROM public.agent18_migrations WHERE name='006_core_abstractions.sql');
