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
  Users,
  BookOpen,
  Eye,
} from 'lucide-react';
import {
  useBrainGraph,
  type BrainItem,
  type EntryRelationship,
} from '@/hooks/useBrainGraph';
import { useBrainEntities, type BrainEntity } from '@/hooks/useBrainEntities';
import { usePrinciples, type JacPrinciple } from '@/hooks/usePrinciples';

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
            {item.access_count != null && item.access_count > 0 && (
              <span className="text-[10px] text-white/40 font-mono">
                accessed: {item.access_count}x
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

        {/* Freshness */}
        {item.last_accessed_at && (
          <div className="px-4 py-2 border-b border-white/10">
            <div className="flex items-center gap-2">
              <Eye className="w-3.5 h-3.5 text-white/30" />
              <span className="text-[10px] text-white/40 font-mono">
                Last accessed: {timeAgo(item.last_accessed_at)}
              </span>
            </div>
          </div>
        )}

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

  const { entities: brainEntities, mentions, selectedEntityId, fetchMentions, isLoading: entitiesLoading } = useBrainEntities(userId);
  const { principles, isLoading: principlesLoading } = usePrinciples(userId);

  // Extended tab state (includes entities + principles beyond what the hook supports)
  type ExtendedTab = 'all' | 'entries' | 'reflections' | 'entities' | 'principles';
  const [activeTab, setActiveTab] = useState<ExtendedTab>('all');

  const handleTabChange = (t: ExtendedTab) => {
    setActiveTab(t);
    if (t === 'all' || t === 'entries' || t === 'reflections') {
      setTab(t);
    }
  };

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
          {entries.length} entries / {reflections.length} reflections / {brainEntities.length} entities / {principles.length} principles
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left column: Items list (60%) */}
        <div className="w-[60%] border-r border-white/10 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="shrink-0 border-b border-white/10 flex">
            {([
              { key: 'all', label: 'All' },
              { key: 'entries', label: 'Entries' },
              { key: 'reflections', label: 'Reflections' },
              { key: 'entities', label: 'Entities' },
              { key: 'principles', label: 'Principles' },
            ] as const).map((t) => (
              <button
                key={t.key}
                onClick={() => handleTabChange(t.key as ExtendedTab)}
                className={cn(
                  'px-4 py-2 text-xs font-medium transition-colors border-b-2',
                  activeTab === t.key
                    ? 'text-white/80 border-blue-500'
                    : 'text-white/40 border-transparent hover:text-white/60',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Item list */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'entities' ? (
              entitiesLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
                </div>
              ) : brainEntities.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <Users className="w-6 h-6 text-white/20" />
                  <span className="text-sm text-white/30">No entities yet</span>
                </div>
              ) : (
                (() => {
                  const grouped: Record<string, BrainEntity[]> = {};
                  for (const e of brainEntities) {
                    const key = e.entity_type || 'unknown';
                    if (!grouped[key]) grouped[key] = [];
                    grouped[key].push(e);
                  }
                  return Object.entries(grouped).map(([type, entities]) => (
                    <div key={type}>
                      <div className="px-3 py-1.5 bg-white/[0.02] border-b border-white/5">
                        <span className="text-[10px] text-white/40 uppercase tracking-wide font-medium">
                          {type}
                        </span>
                        <span className="text-[10px] text-white/20 ml-2">{entities.length}</span>
                      </div>
                      {entities.map((entity) => (
                        <button
                          key={entity.id}
                          onClick={() => fetchMentions(entity.id)}
                          className={cn(
                            'w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors flex items-start gap-2',
                            selectedEntityId === entity.id && 'bg-white/[0.05] border-l-2 border-l-blue-500',
                          )}
                        >
                          <Users className="w-3.5 h-3.5 text-white/30 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-white/70 font-medium">{entity.name}</span>
                              <span className="text-[10px] text-white/30 font-mono">{entity.mention_count}x</span>
                            </div>
                            <span className="text-[10px] text-white/30">
                              first: {timeAgo(entity.first_seen)} / last: {timeAgo(entity.last_seen)}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  ));
                })()
              )
            ) : activeTab === 'principles' ? (
              principlesLoading ? (
                <div className="flex items-center justify-center h-32">
                  <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
                </div>
              ) : principles.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <BookOpen className="w-6 h-6 text-white/20" />
                  <span className="text-sm text-white/30">No principles yet</span>
                </div>
              ) : (
                principles.map((p) => (
                  <div
                    key={p.id}
                    className="w-full text-left px-3 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <BookOpen className="w-3.5 h-3.5 text-white/30 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-white/70 line-clamp-2">{p.principle}</p>
                        <div className="flex items-center gap-3 mt-1.5">
                          {/* Confidence bar */}
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-white/30">confidence:</span>
                            <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-emerald-400 rounded-full"
                                style={{ width: `${Math.round(p.confidence * 100)}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-white/40 font-mono">
                              {Math.round(p.confidence * 100)}%
                            </span>
                          </div>
                          <span className="text-[10px] text-white/30 font-mono">
                            applied: {p.times_applied}x
                          </span>
                          <span className="text-[10px] text-white/20">
                            validated: {timeAgo(p.last_validated)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )
            ) : isLoading ? (
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
          {activeTab === 'entities' && selectedEntityId ? (
            <div className="flex flex-col h-full">
              <div className="px-4 py-3 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-white/40" />
                  <span className="text-sm font-medium text-white/70">
                    {brainEntities.find(e => e.id === selectedEntityId)?.name ?? 'Entity'}
                  </span>
                </div>
                <span className="text-[10px] text-white/30 mt-1 block">
                  {mentions.length} mention{mentions.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto px-4 py-2">
                {mentions.length === 0 ? (
                  <p className="text-[10px] text-white/20 italic">No mentions loaded</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {mentions.map((m) => (
                      <div key={m.id} className="px-2 py-1.5 rounded bg-white/5 border border-white/10">
                        {m.context_snippet && (
                          <p className="text-[11px] text-white/60 line-clamp-2">{m.context_snippet}</p>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          {m.entry_id && (
                            <button
                              onClick={() => handleSelectRelated(m.entry_id!)}
                              className="text-[9px] text-blue-400 hover:text-blue-300 font-mono"
                            >
                              entry
                            </button>
                          )}
                          {m.reflection_id && (
                            <span className="text-[9px] text-purple-400 font-mono">reflection</span>
                          )}
                          <span className="text-[9px] text-white/20 ml-auto">{timeAgo(m.created_at)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : selectedItem ? (
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
