SET ROLE agent18_owner;
ALTER TABLE knowledge.document_history ADD COLUMN reason text;
ALTER TABLE knowledge.document_history ADD COLUMN restored_from int;
ALTER TABLE knowledge.document_history ADD CONSTRAINT document_history_version UNIQUE(document_id,version);
ALTER TABLE knowledge.documents ADD CONSTRAINT document_publication_build
 FOREIGN KEY(published_build_id,id,organization_id,project_id) REFERENCES knowledge.builds(id,source_id,organization_id,project_id);
RESET ROLE;
