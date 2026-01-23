-- Fix 1: Make the 'dumps' storage bucket private
UPDATE storage.buckets SET public = false WHERE id = 'dumps';

-- Remove the public read policy for anon users
DROP POLICY IF EXISTS "Public can view dumps" ON storage.objects;

-- Fix 2: Add INSERT policy for profiles table (allows users to create their own profile)
CREATE POLICY "Users can insert their own profile"
ON profiles FOR INSERT
WITH CHECK (auth.uid() = id);