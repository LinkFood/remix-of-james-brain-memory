-- Add pages_url to code_projects for GitHub Pages preview support
ALTER TABLE public.code_projects ADD COLUMN IF NOT EXISTS pages_url TEXT;
