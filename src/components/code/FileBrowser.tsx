/**
 * FileBrowser — Tree view of repository files
 *
 * Groups flat file paths into a nested tree structure.
 * Folders are collapsible, first level expanded by default.
 */

import { useState, useMemo } from 'react';
import { FileText, Folder, FolderOpen, Loader2 } from 'lucide-react';

interface FileBrowserProps {
  files: string[] | null;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  loading: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };

  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: fullPath,
          children: new Map(),
          isFile: isLast,
        });
      }
      current = current.children.get(part)!;
    }
  }

  return root;
}

function sortedEntries(node: TreeNode): TreeNode[] {
  const entries = Array.from(node.children.values());
  // Folders first, then files, alphabetical within each group
  return entries.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function TreeItem({
  node,
  depth,
  selectedFile,
  onSelectFile,
  defaultOpen,
}: {
  node: TreeNode;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (node.isFile) {
    const isSelected = selectedFile === node.path;
    return (
      <button
        onClick={() => onSelectFile(node.path)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs rounded transition-colors ${
          isSelected
            ? 'bg-blue-500/10 text-blue-400'
            : 'text-foreground/70 hover:bg-muted/40'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const children = sortedEntries(node);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-xs text-foreground/80 hover:bg-muted/40 rounded transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {open ? (
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-amber-400/70" />
        ) : (
          <Folder className="w-3.5 h-3.5 shrink-0 text-amber-400/70" />
        )}
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {open && children.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          defaultOpen={depth < 1}
        />
      ))}
    </div>
  );
}

export function FileBrowser({ files, selectedFile, onSelectFile, loading }: FileBrowserProps) {
  const tree = useMemo(() => (files ? buildTree(files) : null), [files]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!tree || !files || files.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">No files loaded</p>
        </div>
      </div>
    );
  }

  const entries = sortedEntries(tree);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
        <span className="text-[10px] text-muted-foreground">{files.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {entries.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            defaultOpen={true}
          />
        ))}
      </div>
    </div>
  );
}
