-- Add system_health to brain_insights type CHECK constraint
ALTER TABLE brain_insights DROP CONSTRAINT IF EXISTS brain_insights_type_check;
ALTER TABLE brain_insights ADD CONSTRAINT brain_insights_type_check
  CHECK (type IN ('pattern','overdue','stale','schedule','suggestion',
    'forgotten','unchecked','activity','heartbeat','morning_brief','system_health'));
