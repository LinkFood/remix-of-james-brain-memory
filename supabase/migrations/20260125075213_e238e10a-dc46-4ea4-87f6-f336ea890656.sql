-- Fix the permissive INSERT policy - restrict to service role only via trigger
-- Drop the overly permissive policy
DROP POLICY "System can create subscriptions" ON public.subscriptions;

-- Create subscriptions for existing users who don't have one
INSERT INTO public.subscriptions (user_id)
SELECT p.id FROM public.profiles p
WHERE NOT EXISTS (
  SELECT 1 FROM public.subscriptions s WHERE s.user_id = p.id
);