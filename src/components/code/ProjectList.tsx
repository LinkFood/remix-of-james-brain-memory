/**
 * ProjectList — Sidebar showing registered code projects
 *
 * Lists project cards with name, repo, and tech stack badges.
 * Active project gets a blue border highlight.
 */

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, GitBranch } from 'lucide-react';
import type { CodeProject } from '@/types/agent';

interface ProjectListProps {
  projects: CodeProject[];
  activeProjectId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}

export function ProjectList({ projects, activeProjectId, onSelect, onAdd, onRemove }: ProjectListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Projects</span>
        <span className="text-[10px] text-muted-foreground">{projects.length}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {projects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <GitBranch className="w-8 h-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">No projects yet</p>
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">Add a GitHub repo to get started</p>
          </div>
        )}

        {projects.map((project) => (
          <div
            key={project.id}
            onClick={() => onSelect(project.id)}
            className={`relative rounded-lg border p-3 cursor-pointer transition-all ${
              activeProjectId === project.id
                ? 'border-blue-500/50 bg-blue-500/5 shadow-sm shadow-blue-500/10'
                : 'border-border bg-card/50 hover:bg-muted/30'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{project.name}</p>
                <p className="text-[10px] text-muted-foreground truncate mt-0.5">{project.repo_full_name}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 h-6 w-6 text-muted-foreground/40 hover:text-red-400"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(project.id);
                }}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>

            {project.tech_stack && project.tech_stack.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {project.tech_stack.slice(0, 4).map((tech) => (
                  <Badge key={tech} variant="secondary" className="text-[9px] px-1.5 py-0">
                    {tech}
                  </Badge>
                ))}
                {project.tech_stack.length > 4 && (
                  <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                    +{project.tech_stack.length - 4}
                  </Badge>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full text-xs gap-1.5"
          onClick={onAdd}
        >
          <Plus className="w-3.5 h-3.5" />
          Add Project
        </Button>
      </div>
    </div>
  );
}
