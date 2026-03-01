import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/ThemeProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import { InstallPrompt } from "./components/InstallPrompt";
import { ActivityTrackingProvider } from "./components/ActivityTrackingProvider";
import { Ticker } from "./components/jac/Ticker";
import { AuthLayout } from "./layouts/AuthLayout";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import Auth from "./pages/Auth";
import Terms from "./pages/Terms";
import Privacy from "./pages/Privacy";
import NotFound from "./pages/NotFound";
import Jac from "./pages/Jac";
import CodeWorkspace from "./pages/CodeWorkspace";
import Calendar from "./pages/Calendar";
import Search from "./pages/Search";
import ActivityLog from "./pages/ActivityLog";
import BrainInspector from "./pages/BrainInspector";
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
      {/* Public routes */}
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />

      {/* Authenticated routes — wrapped in AuthLayout */}
      <Route path="/dashboard" element={<AuthLayout><Dashboard /></AuthLayout>} />
      <Route path="/code" element={<AuthLayout><CodeWorkspace /></AuthLayout>} />
      <Route path="/jac" element={<AuthLayout><Jac /></AuthLayout>} />
      <Route path="/settings" element={<AuthLayout><Settings /></AuthLayout>} />
      <Route path="/calendar" element={<AuthLayout><Calendar /></AuthLayout>} />
      <Route path="/search" element={<AuthLayout><Search /></AuthLayout>} />
      <Route path="/activity" element={<AuthLayout><ActivityLog /></AuthLayout>} />
      <Route path="/brain" element={<AuthLayout><BrainInspector /></AuthLayout>} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  );

  // Only wrap with tracking when authenticated
  if (userId) {
    return (
      <ActivityTrackingProvider userId={userId}>
        {routes}
        <Ticker userId={userId} />
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
