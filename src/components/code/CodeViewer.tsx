/**
 * CodeViewer — Read-only code display with line numbers
 *
 * Shows file content in a monospace pre block with a header bar
 * displaying the file path. Basic language detection from extension.
 */

import { Loader2, FileCode2 } from 'lucide-react';

interface CodeViewerProps {
  content: string | null;
  filePath: string | null;
  loading: boolean;
}

function getLanguageClass(filePath: string | null): string {
  if (!filePath) return '';
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'language-typescript',
    tsx: 'language-typescript',
    js: 'language-javascript',
    jsx: 'language-javascript',
    py: 'language-python',
    rs: 'language-rust',
    go: 'language-go',
    json: 'language-json',
    md: 'language-markdown',
    css: 'language-css',
    html: 'language-html',
    sql: 'language-sql',
    yaml: 'language-yaml',
    yml: 'language-yaml',
    toml: 'language-toml',
    sh: 'language-bash',
    bash: 'language-bash',
  };
  return ext ? (map[ext] || '') : '';
}

export function CodeViewer({ content, filePath, loading }: CodeViewerProps) {
  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border bg-muted/20">
          <span className="text-xs text-muted-foreground">Loading...</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!filePath || content === null) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-border bg-muted/20">
          <span className="text-xs text-muted-foreground">No file selected</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <FileCode2 className="w-10 h-10 text-muted-foreground/20 mb-2" />
          <p className="text-xs text-muted-foreground">Select a file to view its contents</p>
        </div>
      </div>
    );
  }

  const lines = content.split('\n');
  const lineNumberWidth = String(lines.length).length;

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border bg-muted/20 flex items-center gap-2">
        <FileCode2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs text-foreground/80 font-mono truncate">{filePath}</span>
      </div>
      <div className="flex-1 overflow-auto">
        <pre className="text-xs leading-relaxed">
          <code className={getLanguageClass(filePath)}>
            {lines.map((line, i) => (
              <div key={i} className="flex hover:bg-muted/20">
                <span
                  className="select-none text-muted-foreground/40 text-right pr-4 pl-3 shrink-0 font-mono"
                  style={{ minWidth: `${lineNumberWidth + 3}ch` }}
                >
                  {i + 1}
                </span>
                <span className="flex-1 pr-4 font-mono whitespace-pre">{line}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
