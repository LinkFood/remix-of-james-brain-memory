/**
 * useRelatedEntries — Fetch related entries for the Connect layer
 *
 * Given an entry ID, fetches semantically related entries
 * from the find-related-entries edge function.
 */

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface RelatedEntry {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score: number | null;
  created_at: string;
  image_url?: string | null;
  starred?: boolean;
  similarity: number;
  relationship_type: string;
}

export interface RelatedPatterns {
  commonTags?: Array<{ tag: string; count: number }>;
  typeDistribution?: Record<string, number>;
  timeSpan?: {
    earliest: string;
    latest: string;
    daySpan: number;
  };
}

interface UseRelatedEntriesReturn {
  related: RelatedEntry[];
  patterns: RelatedPatterns;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useRelatedEntries(entryId: string | null): UseRelatedEntriesReturn {
  const [related, setRelated] = useState<RelatedEntry[]>([]);
  const [patterns, setPatterns] = useState<RelatedPatterns>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRelated = useCallback(async () => {
    if (!entryId) {
      setRelated([]);
      setPatterns({});
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/find-related-entries`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ entryId, limit: 5 }),
        }
      );

      if (!response.ok) {
        throw new Error("Failed to fetch related entries");
      }

      const data = await response.json();
      setRelated(data.related || []);
      setPatterns(data.patterns || {});
    } catch (err: any) {
      console.error("Failed to fetch related entries:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    fetchRelated();
  }, [fetchRelated]);

  return { related, patterns, loading, error, refetch: fetchRelated };
}
