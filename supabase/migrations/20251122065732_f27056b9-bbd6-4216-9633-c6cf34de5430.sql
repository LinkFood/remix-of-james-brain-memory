-- Add importance_score column to messages table
ALTER TABLE public.messages 
ADD COLUMN importance_score integer CHECK (importance_score >= 0 AND importance_score <= 10);

-- Add index for efficient filtering by importance
CREATE INDEX idx_messages_importance_score ON public.messages(importance_score DESC);

COMMENT ON COLUMN public.messages.importance_score IS 'AI-calculated importance score from 0 (trivial) to 10 (critical)';