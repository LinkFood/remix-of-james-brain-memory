-- Create entries table for brain dump functionality
CREATE TABLE public.entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  title TEXT,
  content_type TEXT NOT NULL DEFAULT 'note',
  content_subtype TEXT,
  tags TEXT[] DEFAULT '{}',
  extracted_data JSONB DEFAULT '{}',
  importance_score INTEGER,
  list_items JSONB DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  starred BOOLEAN NOT NULL DEFAULT false,
  archived BOOLEAN NOT NULL DEFAULT false,
  embedding TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own entries" 
ON public.entries 
FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own entries" 
ON public.entries 
FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own entries" 
ON public.entries 
FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own entries" 
ON public.entries 
FOR DELETE 
USING (auth.uid() = user_id);

-- Create indexes for common queries
CREATE INDEX idx_entries_user_id ON public.entries(user_id);
CREATE INDEX idx_entries_created_at ON public.entries(created_at DESC);
CREATE INDEX idx_entries_content_type ON public.entries(content_type);
CREATE INDEX idx_entries_archived ON public.entries(archived);

-- Create trigger for automatic timestamp updates using existing function
CREATE TRIGGER update_entries_updated_at
BEFORE UPDATE ON public.entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();