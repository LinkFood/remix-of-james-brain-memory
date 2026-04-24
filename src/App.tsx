import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/ThemeProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import { RouteBoundary } from "./components/RouteBoundary";
import { InstallPrompt } from "./components/InstallPrompt";
import { ActivityTrackingProvider } from "./components/ActivityTrackingProvider";
import { FreshnessClockProvider } from "./components/FreshnessClock";
import { Ticker } from "./components/jac/Ticker";
import { AuthLayout } from "./layouts/AuthLayout";
import Dashboard from "./pages/Dashboard";
import Settings from "./pages/Settings";
import CtSettings from "./pages/CtSettings";
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
import Agents from "./pages/Agents";
import CronJobs from "./pages/CronJobs";
import Reports from "./pages/Reports";
import Landing from "./pages/Landing";
import CommandStation from "./pages/CommandStation";
import Scorecard from "./pages/Scorecard";
import PromptAbTest from "./pages/PromptAbTest";
import Replay from "./pages/Replay";
import Workspace from "./pages/Workspace";
import Principles from "./pages/Principles";
import Health from "./pages/Health";
import Edge from "./pages/Edge";
import Pulse from "./pages/Pulse";
import CostDashboard from "./pages/CostDashboard";
import SessionTimeline from "./pages/SessionTimeline";
import ActivityLive from "./pages/ActivityLive";
import TickerTerminal from "./pages/TickerTerminal";
import TickerChart from "./pages/TickerChart";
import CustomRules from "./pages/CustomRules";
import Analogs from "./pages/Analogs";
import { ChatPanel } from "./components/command/ChatPanel";
import { CommandPalette } from "./components/CommandPalette";
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
      <Route path="/welcome" element={<RouteBoundary route="/welcome"><Landing /></RouteBoundary>} />
      <Route path="/auth" element={<RouteBoundary route="/auth"><Auth /></RouteBoundary>} />
      <Route path="/terms" element={<RouteBoundary route="/terms"><Terms /></RouteBoundary>} />
      <Route path="/privacy" element={<RouteBoundary route="/privacy"><Privacy /></RouteBoundary>} />

      {/* Primary authenticated route — co-trader with docked ChatPanel in sidebar slot */}
      <Route path="/" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/"><CommandStation /></RouteBoundary></AuthLayout>} />
      <Route path="/scorecard" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/scorecard"><Scorecard /></RouteBoundary></AuthLayout>} />
      <Route path="/workspace" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/workspace"><Workspace /></RouteBoundary></AuthLayout>} />
      <Route path="/principles" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/principles"><Principles /></RouteBoundary></AuthLayout>} />
      <Route path="/prompts" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/prompts"><PromptAbTest /></RouteBoundary></AuthLayout>} />
      <Route path="/health" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/health"><Health /></RouteBoundary></AuthLayout>} />
      <Route path="/edge" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/edge"><Edge /></RouteBoundary></AuthLayout>} />
      <Route path="/pulse" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/pulse"><Pulse /></RouteBoundary></AuthLayout>} />
      <Route path="/cost" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/cost"><CostDashboard /></RouteBoundary></AuthLayout>} />
      <Route path="/session" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/session"><SessionTimeline /></RouteBoundary></AuthLayout>} />
      <Route path="/activity-live" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/activity-live"><ActivityLive /></RouteBoundary></AuthLayout>} />
      <Route path="/ticker/:symbol" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/ticker/:symbol"><TickerTerminal /></RouteBoundary></AuthLayout>} />
      <Route path="/chart/:symbol/:date" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/chart/:symbol/:date"><TickerChart /></RouteBoundary></AuthLayout>} />
      <Route path="/rules" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/rules"><CustomRules /></RouteBoundary></AuthLayout>} />
      <Route path="/analogs" element={<AuthLayout sidebar={<ChatPanel />}><RouteBoundary route="/analogs"><Analogs /></RouteBoundary></AuthLayout>} />

      {/* Authenticated routes — wrapped in AuthLayout */}
      <Route path="/dashboard" element={<AuthLayout><RouteBoundary route="/dashboard"><Dashboard /></RouteBoundary></AuthLayout>} />
      <Route path="/code" element={<AuthLayout><RouteBoundary route="/code"><CodeWorkspace /></RouteBoundary></AuthLayout>} />
      <Route path="/jac" element={<AuthLayout><RouteBoundary route="/jac"><Jac /></RouteBoundary></AuthLayout>} />
      <Route path="/settings" element={<AuthLayout><RouteBoundary route="/settings"><Settings /></RouteBoundary></AuthLayout>} />
      <Route path="/ct-settings" element={<AuthLayout><RouteBoundary route="/ct-settings"><CtSettings /></RouteBoundary></AuthLayout>} />
      <Route path="/calendar" element={<AuthLayout><RouteBoundary route="/calendar"><Calendar /></RouteBoundary></AuthLayout>} />
      <Route path="/search" element={<AuthLayout><RouteBoundary route="/search"><Search /></RouteBoundary></AuthLayout>} />
      <Route path="/activity" element={<AuthLayout><RouteBoundary route="/activity"><ActivityLog /></RouteBoundary></AuthLayout>} />
      <Route path="/agents" element={<AuthLayout><RouteBoundary route="/agents"><Agents /></RouteBoundary></AuthLayout>} />
      <Route path="/brain" element={<AuthLayout><RouteBoundary route="/brain"><BrainInspector /></RouteBoundary></AuthLayout>} />
      <Route path="/crons" element={<AuthLayout><RouteBoundary route="/crons"><CronJobs /></RouteBoundary></AuthLayout>} />
      <Route path="/reports" element={<AuthLayout><RouteBoundary route="/reports"><Reports /></RouteBoundary></AuthLayout>} />
      <Route path="/replay" element={<AuthLayout><RouteBoundary route="/replay"><Replay /></RouteBoundary></AuthLayout>} />

      <Route path="*" element={<RouteBoundary route="*"><NotFound /></RouteBoundary>} />
    </Routes>
  );

  // Only wrap with tracking when authenticated
  if (userId) {
    return (
      <ActivityTrackingProvider userId={userId}>
        {routes}
        <Ticker userId={userId} />
        <CommandPalette />
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
          <FreshnessClockProvider>
            <Toaster />
            <Sonner />
            <BrowserRouter>
              <TrackedRoutes />
              <InstallPrompt />
            </BrowserRouter>
          </FreshnessClockProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
