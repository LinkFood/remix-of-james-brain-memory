/**
 * Code Workspace — JAC Code Agent interface
 *
 * Three-column desktop layout:
 * - ProjectList sidebar (w-56)
 * - FileBrowser + CodeViewer (flex-1)
 * - AgentTerminal + CodeChat + SessionHistory (bottom/right)
 *
 * Mobile: Tabs for Projects / Files / Terminal / Chat
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Code2, FolderTree, Terminal, MessageSquare, History,
} from 'lucide-react';
import { useCodeWorkspace } from '@/hooks/useCodeWorkspace';
import { ProjectList } from '@/components/code/ProjectList';
import { AddProjectDialog } from '@/components/code/AddProjectDialog';
import { FileBrowser } from '@/components/code/FileBrowser';
import { CodeViewer } from '@/components/code/CodeViewer';
import { AgentTerminal } from '@/components/code/AgentTerminal';
import { CodeChat } from '@/components/code/CodeChat';
import { SessionHistory } from '@/components/code/SessionHistory';

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
    terminalLogs, chatMessages, loading, sending,
    addProject, removeProject, selectProject, setSelectedFile,
    sendCodeCommand, loadFileContent, cancelTask,
  } = useCodeWorkspace(userId);

  // Find the running code task (child task from the active session)
  const runningTaskId = activeSession?.task_id ?? null;
  const isRunning = activeSession?.status === 'active';

  if (!userId) return null;

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      {/* Status bar */}
      <div className="border-b border-border bg-card/50 px-3 h-8 flex items-center gap-2 shrink-0">
        <Code2 className={`w-4 h-4 ${activeSession ? 'text-blue-400' : 'text-primary/60'}`} />
        <span className="text-xs font-semibold">Code Workspace</span>
        {activeSession && (
          <div className="flex items-center gap-1.5 text-xs text-blue-400 ml-auto">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
            Session active
          </div>
        )}
        {!activeSession && activeProject && (
          <div className="text-xs text-muted-foreground ml-auto hidden sm:block">
            {activeProject.repo_full_name}
          </div>
        )}
      </div>

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
            <div className="h-48 border-b border-border overflow-hidden">
              <FileBrowser
                files={fileTree}
                selectedFile={selectedFile}
                onSelectFile={loadFileContent}
                loading={fileLoading}
              />
            </div>
            <div className="flex-1 overflow-hidden">
              <CodeViewer
                content={selectedFileContent}
                filePath={selectedFile}
                loading={fileLoading}
              />
            </div>
          </div>

          {/* Terminal + Chat + Sessions panel */}
          <div className="w-[380px] flex flex-col bg-card/20">
            <Tabs defaultValue="terminal" className="flex-1 flex flex-col">
              <TabsList className="mx-3 mt-2 grid grid-cols-3 h-8">
                <TabsTrigger value="terminal" className="text-xs gap-1.5 h-7">
                  <Terminal className="w-3.5 h-3.5" />
                  Terminal
                </TabsTrigger>
                <TabsTrigger value="chat" className="text-xs gap-1.5 h-7">
                  <MessageSquare className="w-3.5 h-3.5" />
                  Chat
                  {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
                </TabsTrigger>
                <TabsTrigger value="sessions" className="text-xs gap-1.5 h-7">
                  <History className="w-3.5 h-3.5" />
                  Sessions
                </TabsTrigger>
              </TabsList>

              <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden p-2">
                <AgentTerminal
                  logs={terminalLogs}
                  sessionStatus={activeSession?.status ?? null}
                  isRunning={isRunning}
                  onCancel={runningTaskId ? () => cancelTask(runningTaskId) : undefined}
                />
              </TabsContent>

              <TabsContent value="chat" className="flex-1 m-0 overflow-hidden">
                <CodeChat
                  onSend={sendCodeCommand}
                  sending={sending}
                  projectName={activeProject?.name ?? null}
                  messages={chatMessages}
                />
              </TabsContent>

              <TabsContent value="sessions" className="flex-1 m-0 overflow-auto">
                <SessionHistory sessions={sessions} />
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
                {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
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
              <div className="h-48 border-b border-border overflow-hidden">
                <FileBrowser
                  files={fileTree}
                  selectedFile={selectedFile}
                  onSelectFile={loadFileContent}
                  loading={fileLoading}
                />
              </div>
              <div className="flex-1 overflow-hidden">
                <CodeViewer
                  content={selectedFileContent}
                  filePath={selectedFile}
                  loading={fileLoading}
                />
              </div>
            </TabsContent>

            <TabsContent value="terminal" className="flex-1 m-0 overflow-hidden p-2">
              <AgentTerminal
                logs={terminalLogs}
                sessionStatus={activeSession?.status ?? null}
                isRunning={isRunning}
                onCancel={runningTaskId ? () => cancelTask(runningTaskId) : undefined}
              />
            </TabsContent>

            <TabsContent value="chat" className="flex-1 m-0 overflow-hidden">
              <CodeChat
                onSend={sendCodeCommand}
                sending={sending}
                projectName={activeProject?.name ?? null}
                messages={chatMessages}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <AddProjectDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onAdd={(repo, name, stack, branch) => {
          addProject(repo, name, stack, branch);
          setAddDialogOpen(false);
        }}
      />
    </div>
  );
};

export default CodeWorkspace;
