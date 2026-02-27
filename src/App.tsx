import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/ThemeProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import { InstallPrompt } from "./components/InstallPrompt";
import { ActivityTrackingProvider } from "./components/ActivityTrackingProvider";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import Auth from "./pages/Auth";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import NotFound from "./pages/NotFound";
import Jac from "./pages/Jac";
import CodeWorkspace from "./pages/CodeWorkspace";
import Landing from "./pages/Landing";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const queryClient = new QueryClient();

/** Wraps routes with activity tracking when user is authenticated */
const TrackedRoutes = () => {
  const [userId, setUserId] = useState<string>('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? '');
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? '');
    });
    return () => subscription.unsubscribe();
  }, []);

  const routes = (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/jac" element={<Jac />} />
      <Route path="/code" element={<CodeWorkspace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );

  // Only wrap with tracking when authenticated
  if (userId) {
    return (
      <ActivityTrackingProvider userId={userId}>
        {routes}
      </ActivityTrackingProvider>
    );
  }

  return routes;
};

const App = () => (
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <TrackedRoutes />
            <InstallPrompt />
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
