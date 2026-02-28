/**
 * CodeSessionCard — Inline artifact for code task results
 *
 * Shows branch name, files changed, PR link, and merge status.
 */

import { Badge } from '@/components/ui/badge';
import { GitBranch, FileText, ExternalLink, GitMerge } from 'lucide-react';

interface CodeSessionCardProps {
  output: Record<string, unknown>;
}

export function CodeSessionCard({ output }: CodeSessionCardProps) {
  const branch = output.branch ? String(output.branch) : null;
  const prUrl = output.prUrl ? String(output.prUrl) : null;
  const filesWritten = Array.isArray(output.filesWritten) ? output.filesWritten.map(String) : [];
  const merged = Boolean(output.merged);
  const mergeSha = output.mergeSha ? String(output.mergeSha) : null;
  const prNumber = output.prNumber ? Number(output.prNumber) : null;

  return (
    <div className="mt-2 p-3 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.03] max-w-[85%]">
      <div className="flex items-start gap-2">
        <div className="w-6 h-6 rounded-full bg-indigo-500/10 flex items-center justify-center shrink-0">
          <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
        </div>
        <div className="min-w-0 flex-1">
          {/* Branch name */}
          {branch && (
            <p className="text-sm font-mono truncate text-foreground/90">{branch}</p>
          )}

          {/* Files changed */}
          {filesWritten.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground">
              <FileText className="w-3 h-3" />
              <span>{filesWritten.length} file{filesWritten.length > 1 ? 's' : ''} changed</span>
            </div>
          )}

          {/* PR link + status */}
          <div className="flex items-center gap-2 mt-2">
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                PR{prNumber ? ` #${prNumber}` : ''}
              </a>
            )}
            {merged ? (
              <Badge variant="outline" className="text-[9px] text-green-500 border-green-500/30 gap-1">
                <GitMerge className="w-3 h-3" />
                Merged
              </Badge>
            ) : prUrl ? (
              <Badge variant="outline" className="text-[9px] text-amber-400 border-amber-500/30">
                Open
              </Badge>
            ) : null}
          </div>

          {/* Merge SHA */}
          {mergeSha && (
            <p className="text-[10px] text-muted-foreground/50 mt-1 font-mono">
              {mergeSha.slice(0, 7)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
