-- Fix: Replace overly permissive INSERT policy on subscriptions table
-- The "System can create subscriptions" policy uses WITH CHECK (true) which allows
-- any authenticated user to create subscriptions for ANY user_id (billing fraud risk)

-- Drop the insecure policy if it exists
DROP POLICY IF EXISTS "System can create subscriptions" ON public.subscriptions;

-- Create a secure INSERT policy that only allows users to create their own subscription
-- This still works with the SECURITY DEFINER trigger because it runs in the user's auth context
CREATE POLICY "Users can create their own subscription"
ON public.subscriptions
FOR INSERT
WITH CHECK (auth.uid() = user_id);