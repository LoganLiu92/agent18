SET ROLE agent18_owner;
ALTER TABLE knowledge.eval_questions ADD COLUMN expected_answer text NOT NULL DEFAULT '',
 ADD COLUMN forbidden_sources uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN expect_no_answer boolean NOT NULL DEFAULT false,
 ADD COLUMN severity text NOT NULL DEFAULT 'normal' CHECK(severity IN ('normal','high'));
CREATE TABLE knowledge.eval_reviews (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, project_id uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES knowledge.eval_runs(id), question_id uuid NOT NULL REFERENCES knowledge.eval_questions(id),
 candidate boolean NOT NULL DEFAULT false, verdict text NOT NULL CHECK(verdict IN ('correct','incorrect','unknown')),
 note text NOT NULL, actor_id uuid NOT NULL REFERENCES control.operator_accounts(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,project_id) REFERENCES core.projects(organization_id,id)
);
CREATE INDEX eval_reviews_latest ON knowledge.eval_reviews(run_id,question_id,candidate,created_at DESC);
ALTER TABLE knowledge.eval_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge.eval_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_read ON knowledge.eval_reviews FOR SELECT TO agent18_app USING(control.operator_knowledge_access(organization_id,project_id,'read'));
CREATE POLICY operator_insert ON knowledge.eval_reviews FOR INSERT TO agent18_app WITH CHECK(control.operator_knowledge_access(organization_id,project_id,'review'));
GRANT SELECT,INSERT ON knowledge.eval_reviews TO agent18_app;
RESET ROLE;
