-- Conversations optionally relate to one business entity (brand, product,
-- account, campaign). This follows the existing scoped-reference doctrine
-- (see docs/database.md): deliberately NOT a foreign key; referential
-- integrity is enforced in the repository layer. NULL scope = a general
-- workspace conversation.
ALTER TABLE conversation ADD COLUMN scope_type TEXT CHECK (scope_type IN ('brand', 'product', 'account', 'campaign'));
ALTER TABLE conversation ADD COLUMN scope_id TEXT;
CREATE INDEX idx_conversation_scope ON conversation (scope_type, scope_id);
