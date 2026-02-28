/**
 * useJacDashboard — Jac's dashboard transformation hook
 *
 * Sends queries to the jac-dashboard-query edge function and returns
 * structured commands for transforming the dashboard view.
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface JacConnection {
  from: string;
  to: string;
  label?: string;
  strength: number;
}

export interface JacCluster {
  label: string;
  entryIds: string[];
  color?: string;
}

export interface JacInsight {
  title: string;
  body: string;
  type: "insight" | "pattern" | "suggestion" | "question";
}

export interface JacDashboardState {
  /** Whether Jac is currently transforming the dashboard */
  active: boolean;
  /** Loading state */
  loading: boolean;
  /** Text message from Jac */
  message: string | null;
  /** Entry IDs to highlight with glow */
  highlightEntryIds: string[];
  /** Connections between entries */
  connections: JacConnection[];
  /** Entry clusters */
  clusters: JacCluster[];
  /** Insight card */
  insightCard: JacInsight | null;
  /** Entries to surface to top */
  surfaceEntryIds: string[];
  /** Entries that need enrichment */
  enrichmentTargets: string[];
}

const INITIAL_STATE: JacDashboardState = {
  active: false,
  loading: false,
  message: null,
  highlightEntryIds: [],
  connections: [],
  clusters: [],
  insightCard: null,
  surfaceEntryIds: [],
  enrichmentTargets: [],
};

interface UseJacDashboardReturn {
  state: JacDashboardState;
  sendQuery: (query: string) => Promise<void>;
  clearDashboard: () => void;
}

export function useJacDashboard(): UseJacDashboardReturn {
  const [state, setState] = useState<JacDashboardState>(INITIAL_STATE);
  const [conversationHistory, setConversationHistory] = useState<
    Array<{ role: string; content: string }>
  >([]);

  const sendQuery = useCallback(
    async (query: string) => {
      setState((prev) => ({ ...prev, active: true, loading: true }));

      try {
        await supabase.auth.getUser();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) {
          toast.error("Not authenticated");
          setState((prev) => ({ ...prev, loading: false }));
          return;
        }

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-dashboard-query`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              query,
              conversationHistory: conversationHistory.slice(-4),
            }),
          }
        );

        if (!response.ok) {
          throw new Error("Failed to process query");
        }

        const data = await response.json();

        setState({
          active: true,
          loading: false,
          message: data.message || null,
          highlightEntryIds: data.highlightEntryIds || [],
          connections: data.connections || [],
          clusters: data.clusters || [],
          insightCard: data.insightCard || null,
          surfaceEntryIds: data.surfaceEntryIds || [],
          enrichmentTargets: data.enrichmentTargets || [],
        });

        // Update conversation history
        setConversationHistory((prev) => [
          ...prev,
          { role: "user", content: query },
          { role: "assistant", content: data.message || "" },
        ]);
      } catch (err: any) {
        console.error("Jac dashboard query failed:", err);
        toast.error("Jac couldn't process that");
        setState((prev) => ({ ...prev, loading: false }));
      }
    },
    [conversationHistory]
  );

  const clearDashboard = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { state, sendQuery, clearDashboard };
}
