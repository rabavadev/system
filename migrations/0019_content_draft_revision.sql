-- 0019: Content Draft Revision Lineage (STEP 15C)
-- Adds source_variant_id and source_review_id to content_draft_candidate to link
-- Creator revisions directly to the exact source variant and Critic review.

ALTER TABLE content_draft_candidate ADD COLUMN source_variant_id TEXT REFERENCES content_variant (id) ON DELETE SET NULL;
ALTER TABLE content_draft_candidate ADD COLUMN source_review_id TEXT REFERENCES content_review (id) ON DELETE SET NULL;

CREATE INDEX idx_content_draft_candidate_source_variant ON content_draft_candidate (source_variant_id);
CREATE INDEX idx_content_draft_candidate_source_review ON content_draft_candidate (source_review_id);
