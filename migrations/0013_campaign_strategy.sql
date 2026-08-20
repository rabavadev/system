-- 0013: Campaign Strategy & Success Targets (STEP 14B)
-- Adds primary objective, priority, positioning, offer_message, hypothesis, audience_json, targets_json to campaign.

ALTER TABLE campaign ADD COLUMN objective TEXT
  CHECK (objective IS NULL OR objective IN ('revenue', 'conversions', 'traffic', 'leads', 'awareness', 'engagement', 'retention', 'validation'));

ALTER TABLE campaign ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'
  CHECK (priority IN ('high', 'normal', 'low'));

ALTER TABLE campaign ADD COLUMN positioning TEXT;
ALTER TABLE campaign ADD COLUMN offer_message TEXT;
ALTER TABLE campaign ADD COLUMN hypothesis TEXT;
ALTER TABLE campaign ADD COLUMN audience_json TEXT;
ALTER TABLE campaign ADD COLUMN targets_json TEXT;
