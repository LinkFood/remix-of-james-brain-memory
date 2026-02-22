/**
 * AddProjectDialog — Modal for registering a new GitHub project
 *
 * Takes a repo URL or owner/repo, display name, and tech stack tags.
 * Validates repo format before submitting.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (repoFullName: string, name: string, techStack: string[]) => void;
}

function parseRepoFullName(input: string): string | null {
  const trimmed = input.trim();

  // owner/repo format
  const slashMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (slashMatch) return `${slashMatch[1]}/${slashMatch[2]}`;

  // GitHub URL format
  const urlMatch = trimmed.match(/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/, '')}`;

  return null;
}

export function AddProjectDialog({ open, onOpenChange, onAdd }: AddProjectDialogProps) {
  const [repoInput, setRepoInput] = useState('');
  const [name, setName] = useState('');
  const [techStackInput, setTechStackInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const repoFullName = parseRepoFullName(repoInput);
    if (!repoFullName) {
      setError('Enter a valid GitHub repo: owner/repo or full URL');
      return;
    }

    const displayName = name.trim() || repoFullName.split('/')[1];
    const techStack = techStackInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    onAdd(repoFullName, displayName, techStack);
    setRepoInput('');
    setName('');
    setTechStackInput('');
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Project</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="repo" className="text-xs">GitHub Repository</Label>
            <Input
              id="repo"
              placeholder="owner/repo or https://github.com/owner/repo"
              value={repoInput}
              onChange={(e) => {
                setRepoInput(e.target.value);
                setError(null);
              }}
              className="text-sm"
            />
            {error && <p className="text-[11px] text-red-400">{error}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name" className="text-xs">Display Name (optional)</Label>
            <Input
              id="name"
              placeholder="My Project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="stack" className="text-xs">Tech Stack (comma-separated)</Label>
            <Input
              id="stack"
              placeholder="React, TypeScript, Supabase"
              value={techStackInput}
              onChange={(e) => setTechStackInput(e.target.value)}
              className="text-sm"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!repoInput.trim()}>
              Add Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
