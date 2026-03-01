/**
 * CreateWatchDialog — Create new watch or edit existing.
 *
 * Form: name, query, schedule (SchedulePicker), model tier, agent type.
 * Dual-purpose: create or edit mode based on editWatch prop.
 */

import { useState, useMemo } from 'react';
import { Loader2, Plus, Play, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SchedulePicker } from './SchedulePicker';
import type { Watch } from '@/hooks/useWatches';

interface CreateWatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editWatch?: Watch | null;
  onSave: (params: {
    watchName: string;
    query: string;
    cronExpression: string;
    modelTier: string;
    agentType: string;
  }) => Promise<string | null>;
  onTriggerRun?: (watchId: string) => Promise<void>;
}

const MODEL_TIERS = [
  { value: 'haiku', label: 'Haiku', cost: '~$0.001/run', color: 'text-white/50' },
  { value: 'sonnet', label: 'Sonnet', cost: '~$0.01/run', color: 'text-blue-400' },
  { value: 'opus', label: 'Opus', cost: '~$0.05/run', color: 'text-purple-400' },
];

export function CreateWatchDialog({
  open,
  onOpenChange,
  editWatch,
  onSave,
  onTriggerRun,
}: CreateWatchDialogProps) {
  const isEditing = !!editWatch;

  const [watchName, setWatchName] = useState('');
  const [query, setQuery] = useState('');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [modelTier, setModelTier] = useState('haiku');
  const [agentType, setAgentType] = useState('jac-research-agent');
  const [submitting, setSubmitting] = useState(false);
  const [testRunning, setTestRunning] = useState(false);

  // Reset/populate form when dialog opens
  useMemo(() => {
    if (open) {
      if (editWatch) {
        setWatchName(editWatch.input.watchName || editWatch.intent || '');
        setQuery(editWatch.input.query || '');
        setCronExpression(editWatch.cron_expression || '0 9 * * *');
        setModelTier(editWatch.input.modelTier || 'haiku');
        setAgentType(editWatch.type === 'research' ? 'jac-research-agent' : 'jac-research-agent');
      } else {
        setWatchName('');
        setQuery('');
        setCronExpression('0 9 * * *');
        setModelTier('haiku');
        setAgentType('jac-research-agent');
      }
    }
  }, [open, editWatch]);

  const isValid = watchName.trim().length >= 3 && query.trim().length >= 5;

  const handleSave = async () => {
    if (!isValid) return;
    setSubmitting(true);
    try {
      await onSave({
        watchName: watchName.trim(),
        query: query.trim(),
        cronExpression,
        modelTier,
        agentType,
      });
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTestRun = async () => {
    if (!isValid) return;
    setTestRunning(true);
    try {
      const watchId = await onSave({
        watchName: watchName.trim(),
        query: query.trim(),
        cronExpression,
        modelTier,
        agentType,
      });
      if (watchId && onTriggerRun) {
        await onTriggerRun(watchId);
      }
      onOpenChange(false);
    } finally {
      setTestRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-zinc-900 border-white/10 text-white max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            {isEditing ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {isEditing ? 'Edit Watch' : 'Create Watch'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Watch Name */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Watch Name *</label>
            <Input
              value={watchName}
              onChange={e => setWatchName(e.target.value)}
              placeholder="Austin Zillow Watch"
              className="bg-white/5 border-white/10 text-white placeholder:text-white/30"
              autoFocus
            />
            {watchName.length > 0 && watchName.trim().length < 3 && (
              <p className="text-[10px] text-red-400/70 mt-1">At least 3 characters</p>
            )}
          </div>

          {/* Query */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">Query *</label>
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="What should JAC do each run? e.g. Search Zillow for 3-bed houses in Austin under $400k, compare with previous results, and highlight new listings."
              rows={3}
              className="w-full rounded-md bg-white/5 border border-white/10 text-white placeholder:text-white/30 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/40 resize-none"
            />
            {query.length > 0 && query.trim().length < 5 && (
              <p className="text-[10px] text-red-400/70 mt-1">At least 5 characters</p>
            )}
          </div>

          {/* Schedule */}
          <SchedulePicker value={cronExpression} onChange={setCronExpression} />

          {/* Model Tier + Agent Type row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-white/50 mb-1.5 block">Model Tier</label>
              <div className="flex gap-1.5">
                {MODEL_TIERS.map(tier => (
                  <button
                    key={tier.value}
                    type="button"
                    onClick={() => setModelTier(tier.value)}
                    className={cn(
                      'flex-1 text-xs py-2 rounded-md border transition-colors text-center',
                      modelTier === tier.value
                        ? tier.value === 'opus'
                          ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                          : tier.value === 'sonnet'
                            ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                            : 'bg-white/10 border-white/20 text-white/70'
                        : 'bg-white/5 border-white/10 text-white/40 hover:text-white/60',
                    )}
                  >
                    <div>{tier.label}</div>
                    <div className="text-[9px] text-white/30 mt-0.5">{tier.cost}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="w-36">
              <label className="text-xs text-white/50 mb-1.5 block">Agent</label>
              <select
                value={agentType}
                onChange={e => setAgentType(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-2 text-xs text-white outline-none"
              >
                <option value="jac-research-agent">Research</option>
                <option value="jac-search-agent">Search</option>
              </select>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              className="text-white/50 hover:text-white/70 text-xs"
            >
              Cancel
            </Button>
            <div className="flex-1" />
            {!isEditing && onTriggerRun && (
              <Button
                type="button"
                variant="outline"
                disabled={!isValid || testRunning || submitting}
                onClick={handleTestRun}
                className="border-white/10 text-white/70 hover:text-white text-xs"
              >
                {testRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Play className="w-3 h-3 mr-1.5" />}
                Test Run
              </Button>
            )}
            <Button
              type="button"
              disabled={!isValid || submitting || testRunning}
              onClick={handleSave}
              className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-4"
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : null}
              {isEditing ? 'Update Watch' : 'Save Watch'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
