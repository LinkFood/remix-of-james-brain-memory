/**
 * Code Workspace — JAC Code Agent interface
 *
 * Three-column desktop layout:
 * - ProjectList sidebar (w-56)
 * - FileBrowser + CodeViewer (flex-1)
 * - AgentTerminal + CodeChat (bottom/right)
 *
 * Mobile: Tabs for Projects / Files / Terminal / Chat
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, Code2, FolderTree, Terminal, MessageSquare,
} from 'lucide-react';
import { useCodeWorkspace } from '@/hooks/useCodeWorkspace';
import { ProjectList } from '@/components/code/ProjectList';
import { AddProjectDialog } from '@/components/code/AddProjectDialog';

const CodeWorkspace = () => {
  const navigate = useNavigate();
  const [userId, setUserId] = useState<string>('');
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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
    projects, sessions, activeProject, activeSession,
    fileTree, selectedFile, selectedFileContent, fileLoading,
    terminalLogs, loading, sending,
    addProject, removeProject, selectProject, setSelectedFile,
    sendCodeCommand, loadFileContent,
  } = useCodeWorkspace(userId);

  if (!userId) return null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-2.5 flex items-center gap-3">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
              activeSession ? 'bg-blue-500/10' : 'bg-primary/5'
            }`}>
              <Code2 className={`w-5 h-5 ${activeSession ? 'text-blue-400' : 'text-primary/60'}`} />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Code Workspace</h1>
              <p className="text-[10px] text-muted-foreground">JAC Code Agent</p>
            </div>
          </div>

          {/* Active session indicator */}
          <div className="ml-auto flex items-center gap-3">
            {activeSession && (
              <div className="flex items-center gap-1.5 text-xs text-blue-400">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                </span>
                Session active
              </div>
            )}
            {activeProject && (
              <div className="text-xs text-muted-foreground hidden sm:block">
                {activeProject.repo_full_name}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Desktop: 3-column */}
        <div className="hidden md:flex flex-1 overflow-hidden">
          {/* Project sidebar */}
          <div className="w-56 border-r border-border flex-shrink-0">
            <ProjectList
              projects={projects}
              activeProjectId={activeProject?.id ?? null}
              onSelect={selectProject}
              onAdd={() => setAddDialogOpen(true)}
              onRemove={removeProject}
            />
          </div>

          {/* File browser + code viewer */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-border">
            {/* File browser */}
            <div className="border-b border-border">
              <div className="px-3 py-2 flex items-center gap-2">
                <FolderTree className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
                {activeProject && (
                  <span className="text-[10px] text-muted-foreground ml-auto">{fileTree.length} files</span>
                )}
              </div>
              {fileTree.length > 0 ? (
                <div className="max-h-48 overflow-y-auto px-2 pb-2">
                  {fileTree.map((path) => (
                    <button
                      key={path}
                      onClick={() => loadFileContent(path)}
                      className={`w-full text-left text-xs px-2 py-1 rounded truncate transition-colors ${
                        selectedFile === path
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                      }`}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="px-3 pb-3 text-xs text-muted-foreground/60">
                  {activeProject ? 'No files cached. Ask the code agent to sync.' : 'Select a project to browse files.'}
                </div>
              )}
            </div>

            {/* Code viewer */}
            <div className="flex-1 overflow-auto p-3">
              {fileLoading ? (
                <div className="text-xs text-muted-foreground animate-pulse">Loading file...</div>
              ) : selectedFileContent ? (
                <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-words">
                  {selectedFileContent}
                </pre>
              ) : (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground/40">
                  Select a file to view
                </div>
              )}
            </div>
          </div>

          {/* Terminal + Chat panel */}
          <div className="w-[380px] flex flex-col bg-card/20">
            <Tabs defaultValue="terminal" className="flex-1 flex flex-col">
              <TabsList className="mx-3 mt-2 grid grid-cols-2 h-8">
                <TabsTrigger value="terminal" className="text-xs gap-1.5 h-7">
                  <Terminal className="w-3.5 h-3.5" />
                  Terminal
                  {terminalLogs.length > 0 && (
                    <span className="ml-0.5 text-[10px] text-muted-foreground">{terminalLogs.length}</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs gap-1.5 h-7">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Chat
                </TabsTrigger>
              </TabsList>

              <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden">
                <div className="h-full overflow-y-auto p-3 space-y-1 font-mono text-xs">
                  {terminalLogs.length === 0 ? (
                    <div className="text-muted-foreground/40">Agent activity will appear here...</div>
                  ) : (
                    terminalLogs.map((log) => (
                      <div key={log.id} className={`${
                        log.status === 'failed' ? 'text-red-400' :
                        log.status === 'completed' ? 'text-green-400' :
                        'text-muted-foreground'
                      }`}>
                        <span className="text-muted-foreground/50">[{new Date(log.created_at).toLocaleTimeString()}]</span>{' '}
                        <span className="text-blue-400">{log.agent}</span>{' '}
                        {log.step}
                        {log.duration_ms != null && (
                          <span className="text-muted-foreground/40"> ({log.duration_ms}ms)</span>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              <TabsContent value="chat" className="flex-1 m-0 overflow-hidden flex flex-col">
                <div className="flex-1 overflow-y-auto p-3">
                  <div className="text-xs text-muted-foreground/40">
                    Send commands to the JAC Code Agent below.
                  </div>
                </div>
                <div className="border-t border-border p-3">
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const input = e.currentTarget.elements.namedItem('codeCmd') as HTMLInputElement;
                      if (input.value.trim()) {
                        sendCodeCommand(input.value);
                        input.value = '';
                      }
                    }}
                    className="flex gap-2"
                  >
                    <input
                      name="codeCmd"
                      type="text"
                      placeholder={activeProject ? `Ask about ${activeProject.name}...` : 'Select a project first...'}
                      disabled={sending || !activeProject}
                      className="flex-1 bg-muted/30 border border-border rounded-md px-3 py-1.5 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
                    />
                    <Button type="submit" size="sm" disabled={sending || !activeProject} className="text-xs">
                      {sending ? 'Sending...' : 'Send'}
                    </Button>
                  </form>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* Mobile: tabs */}
        <div className="flex-1 flex flex-col md:hidden overflow-hidden">
          <Tabs defaultValue="projects" className="flex-1 flex flex-col">
            <TabsList className="mx-3 mt-2 grid grid-cols-4 h-8">
              <TabsTrigger value="projects" className="text-xs gap-1 h-7">
                <Code2 className="w-3.5 h-3.5" />
                Projects
              </TabsTrigger>
              <TabsTrigger value="files" className="text-xs gap-1 h-7">
                <FolderTree className="w-3.5 h-3.5" />
                Files
              </TabsTrigger>
              <TabsTrigger value="terminal" className="text-xs gap-1 h-7">
                <Terminal className="w-3.5 h-3.5" />
                Terminal
              </TabsTrigger>
              <TabsTrigger value="chat" className="text-xs gap-1 h-7">
                <MessageSquare className="w-3.5 h-3.5" />
                Chat
              </TabsTrigger>
            </TabsList>

            <TabsContent value="projects" className="flex-1 m-0 overflow-hidden">
              <ProjectList
                projects={projects}
                activeProjectId={activeProject?.id ?? null}
                onSelect={selectProject}
                onAdd={() => setAddDialogOpen(true)}
                onRemove={removeProject}
              />
            </TabsContent>

            <TabsContent value="files" className="flex-1 m-0 overflow-hidden flex flex-col">
              {fileTree.length > 0 ? (
                <div className="flex-1 overflow-y-auto p-2">
                  {fileTree.map((path) => (
                    <button
                      key={path}
                      onClick={() => loadFileContent(path)}
                      className={`w-full text-left text-xs px-2 py-1.5 rounded truncate transition-colors ${
                        selectedFile === path
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground'
                      }`}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground/40 p-4 text-center">
                  {activeProject ? 'No files cached. Ask the code agent to sync.' : 'Select a project first.'}
                </div>
              )}
              {selectedFileContent && (
                <div className="border-t border-border max-h-[40vh] overflow-auto p-3">
                  <pre className="text-xs font-mono text-foreground/80 whitespace-pre-wrap break-words">
                    {selectedFileContent}
                  </pre>
                </div>
              )}
            </TabsContent>

            <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden">
              <div className="h-full overflow-y-auto p-3 space-y-1 font-mono text-xs">
                {terminalLogs.length === 0 ? (
                  <div className="text-muted-foreground/40">Agent activity will appear here...</div>
                ) : (
                  terminalLogs.map((log) => (
                    <div key={log.id} className={`${
                      log.status === 'failed' ? 'text-red-400' :
                      log.status === 'completed' ? 'text-green-400' :
                      'text-muted-foreground'
                    }`}>
                      <span className="text-muted-foreground/50">[{new Date(log.created_at).toLocaleTimeString()}]</span>{' '}
                      <span className="text-blue-400">{log.agent}</span>{' '}
                      {log.step}
                    </div>
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="chat" className="flex-1 m-0 overflow-hidden flex flex-col">
              <div className="flex-1 overflow-y-auto p-3">
                <div className="text-xs text-muted-foreground/40">
                  Send commands to the JAC Code Agent below.
                </div>
              </div>
              <div className="border-t border-border p-3">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem('codeCmdMobile') as HTMLInputElement;
                    if (input.value.trim()) {
                      sendCodeCommand(input.value);
                      input.value = '';
                    }
                  }}
                  className="flex gap-2"
                >
                  <input
                    name="codeCmdMobile"
                    type="text"
                    placeholder={activeProject ? `Ask about ${activeProject.name}...` : 'Select a project first...'}
                    disabled={sending || !activeProject}
                    className="flex-1 bg-muted/30 border border-border rounded-md px-3 py-1.5 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
                  />
                  <Button type="submit" size="sm" disabled={sending || !activeProject} className="text-xs">
                    {sending ? '...' : 'Send'}
                  </Button>
                </form>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <AddProjectDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={(repo, name, stack) => {
          addProject(repo, name, stack);
          setAddDialogOpen(false);
        }}
      />
    </div>
  );
};

export default CodeWorkspace;
