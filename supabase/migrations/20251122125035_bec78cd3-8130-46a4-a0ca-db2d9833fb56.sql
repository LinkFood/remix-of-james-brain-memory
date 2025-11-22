-- Add composite indexes for optimized queries
CREATE INDEX IF NOT EXISTS idx_messages_user_created 
ON public.messages(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_user_importance 
ON public.messages(user_id, importance_score DESC NULLS LAST) 
WHERE importance_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_user_conversation 
ON public.messages(user_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated 
ON public.conversations(user_id, updated_at DESC);

-- Optimize HNSW vector index for better performance
CREATE INDEX IF NOT EXISTS idx_messages_embedding_hnsw 
ON public.messages 
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE embedding IS NOT NULL;

-- Add covering index for common queries
CREATE INDEX IF NOT EXISTS idx_messages_vault_query 
ON public.messages(user_id, created_at DESC, importance_score) 
INCLUDE (content, role, topic);