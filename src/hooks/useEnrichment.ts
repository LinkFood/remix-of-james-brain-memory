/**
 * useEnrichment — Fetch external context for an entry
 *
 * Calls the enrich-entry edge function to get AI-generated
 * external context (docs, patterns, suggestions) for an entry.
 */

import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface EnrichmentInsight {
  type: "documentation" | "pattern" | "suggestion" | "context" | "warning" | "related";
  title: string;
  content: string;
  confidence: number;
  source?: string;
}

export interface Enrichment {
  summary: string;
  insights: EnrichmentInsight[];
  generatedAt?: string;
}

interface UseEnrichmentReturn {
  enrichment: Enrichment | null;
  loading: boolean;
  error: string | null;
  fetchEnrichment: (entryId: string, content: string, contentType: string, title?: string, tags?: string[]) => Promise<void>;
}

export function useEnrichment(): UseEnrichmentReturn {
  const [enrichment, setEnrichment] = useState<Enrichment | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEnrichment = useCallback(
    async (
      entryId: string,
      content: string,
      contentType: string,
      title?: string,
      tags?: string[]
    ) => {
      setLoading(true);
      setError(null);
      setEnrichment(null);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        const response = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/enrich-entry`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ entryId, content, contentType, title, tags }),
          }
        );

        if (!response.ok) {
          throw new Error("Enrichment failed");
        }

        const data = await response.json();
        setEnrichment(data.enrichment || null);
      } catch (err: any) {
        console.error("Enrichment failed:", err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  return { enrichment, loading, error, fetchEnrichment };
}
