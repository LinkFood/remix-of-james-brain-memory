-- Add image_url column to entries table
ALTER TABLE public.entries ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Create storage bucket for dumps (images, files)
INSERT INTO storage.buckets (id, name, public)
VALUES ('dumps', 'dumps', true)
ON CONFLICT (id) DO NOTHING;

-- RLS: Users can upload to their own folder
CREATE POLICY "Users can upload their own dumps"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'dumps' AND (storage.foldername(name))[1] = auth.uid()::text);

-- RLS: Users can view their own uploads
CREATE POLICY "Users can view their own dumps"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'dumps' AND (storage.foldername(name))[1] = auth.uid()::text);

-- RLS: Users can delete their own uploads
CREATE POLICY "Users can delete their own dumps"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'dumps' AND (storage.foldername(name))[1] = auth.uid()::text);

-- Public can view (since bucket is public for displaying images)
CREATE POLICY "Public can view dumps"
ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'dumps');