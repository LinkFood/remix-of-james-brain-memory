/**
 * EnrichmentCard — External context for an entry
 *
 * Part of the Enrich layer. Shows AI-generated external context
 * like documentation links, patterns, suggestions, and warnings.
 * Only loads on demand (user clicks "Get Context").
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Sparkles,
  BookOpen,
  AlertTriangle,
  Lightbulb,
  Link2,
  Zap,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEnrichment, type EnrichmentInsight } from "@/hooks/useEnrichment";

interface EnrichmentCardProps {
  entryId: string;
  content: string;
  contentType: string;
  title?: string | null;
  tags?: string[];
}

const insightIcons: Record<string, React.ReactNode> = {
  documentation: <BookOpen className="w-3.5 h-3.5" />,
  pattern: <Zap className="w-3.5 h-3.5" />,
  suggestion: <Lightbulb className="w-3.5 h-3.5" />,
  context: <Link2 className="w-3.5 h-3.5" />,
  warning: <AlertTriangle className="w-3.5 h-3.5" />,
  related: <Link2 className="w-3.5 h-3.5" />,
};

const insightColors: Record<string, string> = {
  documentation: "text-blue-400",
  pattern: "text-purple-400",
  suggestion: "text-yellow-400",
  context: "text-green-400",
  warning: "text-red-400",
  related: "text-sky-400",
};

const EnrichmentCard = ({
  entryId,
  content,
  contentType,
  title,
  tags,
}: EnrichmentCardProps) => {
  const { enrichment, loading, error, fetchEnrichment } = useEnrichment();
  const [expanded, setExpanded] = useState(true);

  const handleEnrich = () => {
    fetchEnrichment(entryId, content, contentType, title || undefined, tags);
  };

  // Don't show for very short entries
  if (content.length < 30) return null;

  // Not yet loaded — show button
  if (!enrichment && !loading && !error) {
    return (
      <div className="mt-6 pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          onClick={handleEnrich}
          className="gap-2 text-muted-foreground hover:text-foreground"
        >
          <Sparkles className="w-4 h-4" />
          Get External Context
        </Button>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div className="mt-6 pt-4 border-t">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Enriching with external context...</span>
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="mt-6 pt-4 border-t">
        <p className="text-sm text-muted-foreground">
          Couldn't load external context.{" "}
          <button className="underline" onClick={handleEnrich}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  if (!enrichment || enrichment.insights.length === 0) return null;

  return (
    <div className="mt-6 pt-4 border-t">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-yellow-400" />
          <p className="text-sm font-medium">External Context</p>
          <Badge variant="secondary" className="text-xs">
            {enrichment.insights.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </Button>
      </div>

      {enrichment.summary && (
        <p className="text-xs text-muted-foreground mb-3">
          {enrichment.summary}
        </p>
      )}

      {expanded && (
        <div className="space-y-2">
          {enrichment.insights.map((insight, index) => (
            <InsightItem key={index} insight={insight} />
          ))}
        </div>
      )}
    </div>
  );
};

function InsightItem({ insight }: { insight: EnrichmentInsight }) {
  const icon = insightIcons[insight.type] || insightIcons.context;
  const color = insightColors[insight.type] || insightColors.context;

  return (
    <Card className="p-3 bg-muted/30">
      <div className="flex items-start gap-2">
        <span className={cn("mt-0.5 shrink-0", color)}>{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{insight.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {insight.content}
          </p>
          {insight.source && (
            <p className="text-xs text-muted-foreground/60 mt-1 italic">
              {insight.source}
            </p>
          )}
        </div>
        <Badge variant="outline" className="text-xs shrink-0">
          {Math.round(insight.confidence * 100)}%
        </Badge>
      </div>
    </Card>
  );
}

export default EnrichmentCard;
