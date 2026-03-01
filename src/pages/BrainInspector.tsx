/**
 * BrainInspector -- Debugging tool for JAC's intelligence.
 *
 * Two-column layout: item list (left 60%) + inspector panel (right 40%).
 * Shows entries, reflections, embedding status, and semantic relationships.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  Brain,
  Search,
  Loader2,
  Link2,
  Lightbulb,
  FileText,
  Tag,
  Zap,
  ChevronRight,
} from 'lucide-react';
import {
  useBrainGraph,
  type BrainItem,
  type EntryRelationship,
} from '@/hooks/useBrainGraph';

// --------------- Constants ---------------

const CONTENT_TYPE_COLORS: Record<string, string> = {
  note: 'bg-white/10 text-white/50',
  idea: 'bg-yellow-500/20 text-yellow-400',
  link: 'bg-blue-500/20 text-blue-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  list: 'bg-green-500/20 text-green-400',
  contact: 'bg-pink-500/20 text-pink-400',
  event: 'bg-orange-500/20 text-orange-400',
  reminder: 'bg-red-500/20 text-red-400',
  image: 'bg-purple-500/20 text-purple-400',
  document: 'bg-teal-500/20 text-teal-400',
};

const TASK_TYPE_COLORS: Record<string, string> = {
  research: 'bg-cyan-500/20 text-cyan-400',
  save: 'bg-emerald-500/20 text-emerald-400',
  search: 'bg-blue-500/20 text-blue-400',
  code: 'bg-indigo-500/20 text-indigo-400',
  general: 'bg-white/10 text-white/50',
};

// --------------- Helpers ---------------

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function similarityColor(score: number): string {
  const pct = score * 100;
  if (pct >= 80) return 'text-emerald-400';
  if (pct >= 60) return 'text-yellow-400';
  return 'text-white/40';
}

function similarityBgColor(score: number): string {
  const pct = score * 100;
  if (pct >= 80) return 'bg-emerald-500/10 border-emerald-500/20';
  if (pct >= 60) return 'bg-yellow-500/10 border-yellow-500/20';
  return 'bg-white/5 border-white/10';
}

// --------------- Sub-components ---------------

function ItemListEntry({
  item,
  isSelected,
  onSelect,
}: {
  item: BrainItem;
  isSelected: boolean;
  onSelect: () => void;
}) {
  if (item.kind === 'entry') {
    const typeBadge =
      CONTENT_TYPE_COLORS[item.content_type] ?? 'bg-white/10 text-white/50';
    return (
      <button
        onClick={onSelect}
        className={cn(
          'w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors flex items-start gap-2',
          isSelected && 'bg-white/[0.05] border-l-2 border-l-blue-500',
        )}
      >
        <FileText className="w-3.5 h-3.5 text-white/30 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide shrink-0',
                typeBadge,
              )}
            >
              {item.content_type}
            </span>
            {item.has_embedding && (
              <Zap className="w-3 h-3 text-emerald-400/50 shrink-0" />
            )}
          </div>
          <p className="text-xs text-white/70 mt-0.5 line-clamp-1">
            {item.title || item.content.slice(0, 80)}
          </p>
          <span className="text-[10px] text-white/30">{timeAgo(item.created_at)}</span>
        </div>
      </button>
    );
  }

  // Reflection
  const typeBadge =
    TASK_TYPE_COLORS[item.task_type] ?? 'bg-white/10 text-white/50';
  return (
    <button
      onClick={onSelect}
      className={cn(
        'w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors flex items-start gap-2',
        isSelected && 'bg-white/[0.05] border-l-2 border-l-blue-500',
      )}
    >
      <Lightbulb className="w-3.5 h-3.5 text-blue-400/50 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide shrink-0',
              typeBadge,
            )}
          >
            {item.task_type}
          </span>
          <span className="text-[9px] text-blue-400/60 font-medium">
            reflection
          </span>
        </div>
        <p className="text-xs text-white/70 mt-0.5 line-clamp-1">
          {item.summary}
        </p>
        <span className="text-[10px] text-white/30">{timeAgo(item.created_at)}</span>
      </div>
    </button>
  );
}

function RelationshipCard({
  rel,
  onSelect,
}: {
  rel: EntryRelationship;
  onSelect: (id: string) => void;
}) {
  const pct = Math.round(rel.similarity_score * 100);
  return (
    <button
      onClick={() => onSelect(rel.related_entry_id)}
      className={cn(
        'w-full text-left px-3 py-2 rounded border transition-colors hover:bg-white/[0.03]',
        similarityBgColor(rel.similarity_score),
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-white/70 line-clamp-1">
            {rel.related_title || 'Untitled'}
          </p>
          {rel.related_content_type && (
            <span
              className={cn(
                'text-[9px] px-1 py-0.5 rounded font-medium uppercase tracking-wide mt-0.5 inline-block',
                CONTENT_TYPE_COLORS[rel.related_content_type] ??
                  'bg-white/10 text-white/50',
              )}
            >
              {rel.related_content_type}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <span
            className={cn(
              'text-sm font-mono font-bold',
              similarityColor(rel.similarity_score),
            )}
          >
            {pct}%
          </span>
          <ChevronRight className="w-3 h-3 text-white/20" />
        </div>
      </div>
    </button>
  );
}

function InspectorPanel({
  item,
  relationships,
  relationshipsLoading,
  onSelectRelated,
}: {
  item: BrainItem;
  relationships: EntryRelationship[];
  relationshipsLoading: boolean;
  onSelectRelated: (id: string) => void;
}) {
  if (item.kind === 'entry') {
    return (
      <div className="flex flex-col h-full">
        {/* Details */}
        <div className="px-4 py-3 border-b border-white/10">
          <h3 className="text-sm font-medium text-white/80">
            {item.title || 'Untitled'}
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span
              className={cn(
                'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
                CONTENT_TYPE_COLORS[item.content_type] ??
                  'bg-white/10 text-white/50',
              )}
            >
              {item.content_type}
            </span>
            {item.importance_score != null && (
              <span className="text-[10px] text-white/40 font-mono">
                importance: {item.importance_score}/10
              </span>
            )}
            <span className="text-[10px] text-white/30">
              {new Date(item.created_at).toLocaleDateString()}
            </span>
          </div>
          {item.tags && item.tags.length > 0 && (
            <div className="flex items-center gap-1 mt-2 flex-wrap">
              <Tag className="w-3 h-3 text-white/30" />
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/50"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Content */}
        <div className="px-4 py-3 border-b border-white/10 max-h-48 overflow-y-auto">
          <p className="text-xs text-white/60 whitespace-pre-wrap font-mono leading-relaxed">
            {item.content}
          </p>
        </div>

        {/* Embedding info */}
        <div className="px-4 py-2 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Zap
              className={cn(
                'w-3.5 h-3.5',
                item.has_embedding ? 'text-emerald-400' : 'text-white/20',
              )}
            />
            <span className="text-[10px] text-white/40 font-mono">
              Embedding:{' '}
              {item.has_embedding ? (
                <span className="text-emerald-400">present</span>
              ) : (
                <span className="text-white/20">none</span>
              )}
            </span>
          </div>
        </div>

        {/* Semantic neighbors */}
        <div className="px-4 py-3 flex-1 overflow-y-auto">
          <div className="flex items-center gap-2 mb-2">
            <Link2 className="w-3.5 h-3.5 text-white/40" />
            <span className="text-xs font-medium text-white/60">
              Semantic Neighbors
            </span>
            {relationshipsLoading && (
              <Loader2 className="w-3 h-3 text-white/30 animate-spin" />
            )}
          </div>

          {!relationshipsLoading && relationships.length === 0 ? (
            <p className="text-[10px] text-white/20 italic">
              No relationships found
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {relationships.map((rel) => (
                <RelationshipCard
                  key={rel.id}
                  rel={rel}
                  onSelect={onSelectRelated}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Reflection inspector
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-blue-400/60" />
          <span className="text-sm font-medium text-blue-400">
            JAC Reflection
          </span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span
            className={cn(
              'text-[9px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wide',
              TASK_TYPE_COLORS[item.task_type] ?? 'bg-white/10 text-white/50',
            )}
          >
            {item.task_type}
          </span>
          <span className="text-[10px] text-white/30">
            {new Date(item.created_at).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Intent */}
      {item.intent && (
        <div className="px-4 py-2 border-b border-white/10">
          <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">
            Original Intent
          </span>
          <p className="text-xs text-white/60 mt-0.5">{item.intent}</p>
        </div>
      )}

      {/* Summary */}
      <div className="px-4 py-3 border-b border-white/10 max-h-48 overflow-y-auto">
        <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">
          Summary
        </span>
        <p className="text-xs text-white/70 mt-1 whitespace-pre-wrap leading-relaxed">
          {item.summary}
        </p>
      </div>

      {/* Connections */}
      <div className="px-4 py-3 flex-1 overflow-y-auto">
        <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">
          Connected Entries
        </span>
        {item.connections && item.connections.length > 0 ? (
          <div className="flex flex-col gap-1 mt-1.5">
            {item.connections.map((connId, i) => (
              <button
                key={connId}
                onClick={() => onSelectRelated(connId)}
                className="text-left text-[10px] text-white/50 font-mono px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors truncate"
              >
                {connId}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-white/20 italic mt-1">
            No connections
          </p>
        )}
      </div>
    </div>
  );
}

// --------------- Page ---------------

const BrainInspector = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session?.user) {
        navigate('/auth');
        return;
      }
      setUserId(session.user.id);
    });
  }, [navigate]);

  const {
    entries,
    reflections,
    allItems,
    selectedItem,
    selectItem,
    relationships,
    relationshipsLoading,
    isLoading,
    tab,
    setTab,
  } = useBrainGraph(userId);

  // Handle selecting a related entry by ID
  const handleSelectRelated = (entryId: string) => {
    const found = entries.find((e) => e.id === entryId);
    if (found) {
      selectItem({ ...found, kind: 'entry' });
    }
  };

  if (!userId) return null;

  return (
    <div className="h-[calc(100vh-3.5rem)] bg-background flex flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-white/10 px-4 py-3 flex items-center gap-3">
        <Brain className="w-4 h-4 text-white/40" />
        <span className="text-sm font-medium text-white/70">
          Brain Inspector
        </span>
        <span className="text-[10px] text-white/30 font-mono ml-auto">
          {entries.length} entries / {reflections.length} reflections
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: Items list (60%) */}
        <div className="w-[60%] border-r border-white/10 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="shrink-0 border-b border-white/10 flex">
            {(['all', 'entries', 'reflections'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'px-4 py-2 text-xs font-medium transition-colors border-b-2',
                  tab === t
                    ? 'text-white/80 border-blue-500'
                    : 'text-white/40 border-transparent hover:text-white/60',
                )}
              >
                {t === 'all'
                  ? 'All'
                  : t === 'entries'
                    ? 'Entries'
                    : 'Reflections'}
              </button>
            ))}
          </div>

          {/* Item list */}
          <div className="flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
              </div>
            ) : allItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <Search className="w-6 h-6 text-white/20" />
                <span className="text-sm text-white/30">
                  {tab === 'reflections'
                    ? 'No reflections yet'
                    : 'No entries yet'}
                </span>
              </div>
            ) : (
              allItems.map((item) => (
                <ItemListEntry
                  key={`${item.kind}-${item.id}`}
                  item={item}
                  isSelected={
                    selectedItem?.id === item.id &&
                    selectedItem?.kind === item.kind
                  }
                  onSelect={() => selectItem(item)}
                />
              ))
            )}
          </div>
        </div>

        {/* Right column: Inspector (40%) */}
        <div className="w-[40%] flex flex-col overflow-hidden bg-white/[0.01]">
          {selectedItem ? (
            <InspectorPanel
              item={selectedItem}
              relationships={relationships}
              relationshipsLoading={relationshipsLoading}
              onSelectRelated={handleSelectRelated}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full gap-2">
              <Brain className="w-8 h-8 text-white/10" />
              <span className="text-xs text-white/20">
                Select an item to inspect
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BrainInspector;
