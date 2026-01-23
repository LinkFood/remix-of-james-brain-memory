-- Make dumps bucket private and remove public access policy
UPDATE storage.buckets 
SET public = false 
WHERE id = 'dumps';

-- Drop the public access policy that allows anonymous users to view all files
DROP POLICY IF EXISTS "Public can view dumps" ON storage.objects;