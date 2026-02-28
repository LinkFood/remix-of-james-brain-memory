/**
 * ArtifactCard — Switch component that picks the right card type
 *
 * Based on the task type, renders the appropriate inline artifact card.
 */

import type { AgentTask } from '@/types/agent';
import { BrainEntryCard } from './BrainEntryCard';
import { SearchResultsCard } from './SearchResultsCard';
import { CodeSessionCard } from './CodeSessionCard';
import { ResearchBriefCard } from './ResearchBriefCard';

interface ArtifactCardProps {
  task: AgentTask;
}

export function ArtifactCard({ task }: ArtifactCardProps) {
  if (!task.output || task.status !== 'completed') return null;

  const output = task.output as Record<string, unknown>;

  switch (task.type) {
    case 'save':
      return <BrainEntryCard output={output} />;
    case 'search':
      return <SearchResultsCard output={output} />;
    case 'code':
      return <CodeSessionCard output={output} />;
    case 'research':
    case 'report':
      return <ResearchBriefCard output={output} />;
    default:
      return null;
  }
}
