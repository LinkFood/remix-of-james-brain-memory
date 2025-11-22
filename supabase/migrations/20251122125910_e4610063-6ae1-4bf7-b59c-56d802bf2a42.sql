-- Add new columns to conversations table for UX features
ALTER TABLE public.conversations
ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Add new columns to messages table for message actions
ALTER TABLE public.messages
ADD COLUMN IF NOT EXISTS starred BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS edited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS edit_history JSONB DEFAULT '[]';

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_conversations_pinned 
ON public.conversations(user_id, pinned DESC, updated_at DESC)
WHERE pinned = true;

CREATE INDEX IF NOT EXISTS idx_conversations_archived 
ON public.conversations(user_id, archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_starred 
ON public.messages(user_id, starred, created_at DESC)
WHERE starred = true;

-- Add RLS policies for message updates (edit, star, delete)
DROP POLICY IF EXISTS "Users can update their own messages" ON public.messages;
CREATE POLICY "Users can update their own messages" 
ON public.messages 
FOR UPDATE 
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own messages" ON public.messages;
CREATE POLICY "Users can delete their own messages" 
ON public.messages 
FOR DELETE 
USING (auth.uid() = user_id);