-- A chat can keep more than one version of a turn: a message the writer edited, or a reply
-- asked for again. Each message follows its parent, so the versions form a tree, and the
-- conversation remembers the last message of the version on screen.
ALTER TABLE ai_messages ADD COLUMN parent_id TEXT;
ALTER TABLE ai_conversations ADD COLUMN leaf_id TEXT;

-- Chats from before this are one line: each message follows the one before it.
UPDATE ai_messages SET parent_id = (
  SELECT p.id FROM ai_messages p
  WHERE p.conversation_id = ai_messages.conversation_id
    AND (p.created_at < ai_messages.created_at OR (p.created_at = ai_messages.created_at AND p.id < ai_messages.id))
  ORDER BY p.created_at DESC, p.id DESC
  LIMIT 1
);

CREATE INDEX ai_messages_parent ON ai_messages(parent_id);
