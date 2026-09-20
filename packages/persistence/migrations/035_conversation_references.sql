SET ROLE agent18_owner;
ALTER TABLE core.conversation_messages ADD COLUMN result_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(result_refs)='array' AND jsonb_array_length(result_refs)<=5);
RESET ROLE;
