/**
 * useCodeWorkspace — Hook for Code Workspace page
 *
 * Manages code projects, sessions, file browsing, and agent commands.
 * Follows useJacAgent patterns for supabase client, realtime, and auth.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { CodeProject, CodeSession, AgentTask, ActivityLogEntry, ChatMessage } from '@/types/agent';
import type { RealtimeChannel } from '@supabase/supabase-js';

const JAC_DISPATCHER_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/jac-dispatcher`;

export function useCodeWorkspace(userId: string) {
  const [projects, setProjects] = useState<CodeProject[]>([]);
  const [sessions, setSessions] = useState<CodeSession[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<CodeSession | null>(null);
  const [fileTree, setFileTree] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileContent, setSelectedFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [terminalLogs, setTerminalLogs] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const sendingRef = useRef(false);
  const channelsRef = useRef<RealtimeChannel[]>([]);

  // Derived active project
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null;

  // Load projects + sessions on mount
  useEffect(() => {
    if (!userId) return;

    const loadInitial = async () => {
      setLoading(true);

      try {
        // Load code_projects
        const { data: projectData, error: projError } = await supabase
          .from('code_projects' as any)
          .select('*')
          .eq('user_id', userId)
          .eq('active', true)
          .order('updated_at', { ascending: false });

        if (projError) {
          console.warn('[useCodeWorkspace] code_projects not ready:', projError.message);
        } else if (projectData) {
          setProjects(projectData as unknown as CodeProject[]);
        }

        // Load code_sessions
        const { data: sessionData, error: sessError } = await supabase
          .from('code_sessions' as any)
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(50);

        if (sessError) {
          console.warn('[useCodeWorkspace] code_sessions not ready:', sessError.message);
        } else if (sessionData) {
          setSessions(sessionData as unknown as CodeSession[]);
          // Set active session only if its task is still running
          const active = (sessionData as unknown as CodeSession[]).find(s => s.status === 'active');
          if (active) {
            let isStale = true;
            if (active.task_id) {
              const { data: taskData } = await supabase
                .from('agent_tasks')
                .select('status')
                .eq('id', active.task_id)
                .single();
              if (taskData && (taskData as { status: string }).status === 'running') {
                isStale = false;
              }
            }
            if (isStale) {
              // Clean up stale session
              await supabase
                .from('code_sessions' as any)
                .update({ status: 'completed', updated_at: new Date().toISOString() } as any)
                .eq('id', active.id);
              const cleaned = { ...active, status: 'completed' };
              setSessions(prev => prev.map(s => s.id === active.id ? cleaned as CodeSession : s));
            } else {
              setActiveSession(active);
              setActiveProjectId(active.project_id);
            }
          }
          // Backfill terminal logs for code agent
          try {
            const { data: logData } = await supabase
              .from('agent_activity_log' as any)
              .select('*')
              .eq('agent', 'jac-code-agent')
              .eq('user_id', userId)
              .order('created_at', { ascending: true })
              .limit(200);

            if (logData) {
              setTerminalLogs(logData as unknown as ActivityLogEntry[]);
              // Build chat messages from historical logs
              const msgs: ChatMessage[] = [];
              for (const log of logData as unknown as ActivityLogEntry[]) {
                if (log.step === 'task_started') {
                  const detail = log.detail as Record<string, unknown>;
                  msgs.push({
                    id: `sys-${log.id}`,
                    role: 'system',
                    content: `Task started: ${(detail?.intent as string) || 'code task'}`,
                    timestamp: log.created_at,
                  });
                } else if (log.step === 'task_completed') {
                  const detail = log.detail as Record<string, unknown>;
                  const parts = ['✅ Task completed'];
                  if (detail?.prUrl) parts.push(`PR: ${detail.prUrl}`);
                  if (detail?.fileCount) parts.push(`Files: ${detail.fileCount}`);
                  msgs.push({
                    id: log.id,
                    role: 'agent',
                    content: parts.join('\n'),
                    timestamp: log.created_at,
                    metadata: detail,
                  });
                } else if (log.step === 'task_failed' || log.status === 'failed') {
                  const detail = log.detail as Record<string, unknown>;
                  msgs.push({
                    id: `err-${log.id}`,
                    role: 'system',
                    content: `❌ Failed: ${(detail?.error as string) || log.step}`,
                    timestamp: log.created_at,
                  });
                }
              }
              setChatMessages(msgs);
            }
          } catch (logErr) {
            console.warn('[useCodeWorkspace] Log backfill error:', logErr);
          }
        }
      } catch (err) {
        console.warn('[useCodeWorkspace] Load error:', err);
      }

      setLoading(false);
    };

    loadInitial();
  }, [userId]);

  // Realtime subscriptions
  useEffect(() => {
    if (!userId) return;

    const channels: RealtimeChannel[] = [];

    // code_projects realtime
    const projChannel = supabase
      .channel(`code-projects-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'code_projects',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setProjects(prev => [payload.new as CodeProject, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as CodeProject;
            if (!updated.active) {
              setProjects(prev => prev.filter(p => p.id !== updated.id));
              if (activeProjectId === updated.id) {
                setActiveProjectId(null);
                setFileTree([]);
              }
            } else {
              setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
              // Auto-refresh file tree if this is the active project and tree changed
              if (updated.id === activeProjectId && updated.file_tree_cache) {
                setFileTree(updated.file_tree_cache);
              }
            }
          } else if (payload.eventType === 'DELETE') {
            setProjects(prev => prev.filter(p => p.id !== (payload.old as { id: string }).id));
          }
        }
      )
      .subscribe();
    channels.push(projChannel);

    // code_sessions realtime
    const sessChannel = supabase
      .channel(`code-sessions-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'code_sessions',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newSess = payload.new as CodeSession;
            setSessions(prev => [newSess, ...prev]);
            if (newSess.status === 'active') {
              setActiveSession(newSess);
            }
          } else if (payload.eventType === 'UPDATE') {
            const updated = payload.new as CodeSession;
            setSessions(prev => prev.map(s => s.id === updated.id ? updated : s));
            if (updated.status === 'active') {
              setActiveSession(updated);
            } else if (activeSession?.id === updated.id) {
              setActiveSession(null);
              if (updated.status === 'completed') {
                toast.success(`Session completed: ${updated.intent.slice(0, 60)}`);
              } else if (updated.status === 'failed') {
                toast.error(`Session failed: ${updated.intent.slice(0, 60)}`);
              }
            }
          }
        }
      )
      .subscribe();
    channels.push(sessChannel);

    // agent_tasks (type=code) realtime
    const taskChannel = supabase
      .channel(`code-tasks-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'agent_tasks',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
            const task = payload.new as AgentTask;
            if (task.type === 'code') {
              if (task.status === 'completed') {
                toast.success(`Code task completed: ${(task.intent || '').slice(0, 60)}`);
              } else if (task.status === 'failed') {
                toast.error(`Code task failed: ${(task.error || '').slice(0, 80)}`);
              }
            }
          }
        }
      )
      .subscribe();
    channels.push(taskChannel);

    // agent_activity_log realtime (for terminal)
    const logChannel = supabase
      .channel(`code-logs-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'agent_activity_log',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const newLog = payload.new as ActivityLogEntry;
          if (newLog.agent === 'jac-code-agent') {
            setTerminalLogs(prev => [...prev, newLog]);
            // Generate chat messages from key steps
            if (newLog.step === 'task_started') {
              const detail = newLog.detail as Record<string, unknown>;
              setChatMessages(prev => [...prev, {
                id: `sys-${newLog.id}`,
                role: 'system',
                content: `Task started: ${(detail?.intent as string) || 'code task'}`,
                timestamp: newLog.created_at,
              }]);
            } else if (newLog.step === 'task_completed') {
              const detail = newLog.detail as Record<string, unknown>;
              const parts = ['✅ Task completed'];
              if (detail?.prUrl) parts.push(`PR: ${detail.prUrl}`);
              if (detail?.fileCount) parts.push(`Files: ${detail.fileCount}`);
              setChatMessages(prev => [...prev, {
                id: newLog.id,
                role: 'agent',
                content: parts.join('\n'),
                timestamp: newLog.created_at,
                metadata: detail,
              }]);
            } else if (newLog.step === 'task_failed' || newLog.status === 'failed') {
              const detail = newLog.detail as Record<string, unknown>;
              setChatMessages(prev => [...prev, {
                id: `err-${newLog.id}`,
                role: 'system',
                content: `❌ Failed: ${(detail?.error as string) || newLog.step}`,
                timestamp: newLog.created_at,
              }]);
            } else if (['plan', 'write_code', 'read_file', 'open_pr', 'create_branch'].includes(newLog.step)) {
              setChatMessages(prev => [...prev, {
                id: `step-${newLog.id}`,
                role: 'system',
                content: `${newLog.step.replace(/_/g, ' ')}...`,
                timestamp: newLog.created_at,
              }]);
            }
          }
        }
      )
      .subscribe();
    channels.push(logChannel);

    channelsRef.current = channels;

    return () => {
      channels.forEach(ch => supabase.removeChannel(ch));
      channelsRef.current = [];
    };
  }, [userId, activeProjectId, activeSession?.id]);

  // Add a project
  const addProject = useCallback(async (repoFullName: string, name: string, techStack: string[], defaultBranch = 'main') => {
    try {
      const { data, error } = await supabase
        .from('code_projects' as any)
        .insert({
          user_id: userId,
          repo_full_name: repoFullName,
          name,
          tech_stack: techStack,
          default_branch: defaultBranch,
          active: true,
        } as any)
        .select()
        .single();

      if (error) throw error;
      toast.success(`Added project: ${name}`);
      return data as unknown as CodeProject;
    } catch (err) {
      toast.error('Failed to add project');
      console.error('[useCodeWorkspace] addProject error:', err);
      return null;
    }
  }, [userId]);

  // Remove a project (soft delete)
  const removeProject = useCallback(async (id: string) => {
    try {
      const { error } = await supabase
        .from('code_projects' as any)
        .update({ active: false, updated_at: new Date().toISOString() } as any)
        .eq('id', id);

      if (error) throw error;
      toast.info('Project removed');
    } catch (err) {
      toast.error('Failed to remove project');
      console.error('[useCodeWorkspace] removeProject error:', err);
    }
  }, []);

  // Select a project and load its file tree
  const selectProject = useCallback((id: string) => {
    setActiveProjectId(id);
    setSelectedFile(null);
    setSelectedFileContent(null);

    const project = projects.find(p => p.id === id);
    if (project?.file_tree_cache) {
      setFileTree(project.file_tree_cache);
    } else {
      setFileTree([]);
    }
  }, [projects]);

  // Load file content from GitHub via read-file edge function
  const loadFileContent = useCallback(async (path: string) => {
    setFileLoading(true);
    setSelectedFile(path);
    setSelectedFileContent(null);

    if (!activeProjectId) {
      setSelectedFileContent('// No project selected');
      setFileLoading(false);
      return;
    }

    try {
      await supabase.auth.getUser();
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Not authenticated');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/read-file`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ projectId: activeProjectId, path }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSelectedFileContent(data.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load file';
      setSelectedFileContent(`// Error loading file: ${msg}\n// ${path}`);
      console.warn('[useCodeWorkspace] loadFileContent error:', err);
    }

    setFileLoading(false);
  }, [activeProjectId]);

  // Send a code command to the JAC dispatcher
  const sendCodeCommand = useCallback(async (message: string) => {
    if (!message.trim() || sendingRef.current) return;

    const trimmed = message.trim();
    sendingRef.current = true;
    setSending(true);

    // Add user message to chat
    setChatMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }]);

    try {
      await supabase.auth.getUser();
      const { data: session } = await supabase.auth.getSession();
      if (!session?.session?.access_token) throw new Error('Not authenticated');

      // Include active project context in the dispatch
      const body: Record<string, unknown> = {
        message: trimmed,
        type: 'code',
      };

      if (activeProject) {
        body.context = {
          projectId: activeProject.id,
          repoFullName: activeProject.repo_full_name,
          branch: activeProject.default_branch,
          techStack: activeProject.tech_stack,
        };
      }

      const res = await fetch(JAC_DISPATCHER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.session.access_token}`,
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Request failed: ${res.status}`);
      }

      await res.json();
    } catch (err) {
      const errorText = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Code command failed: ${errorText}`);
      console.error('[useCodeWorkspace] sendCodeCommand error:', err);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [activeProject]);

  // Cancel a running code task (kill switch)
  const cancelTask = useCallback(async (taskId: string) => {
    try {
      const { error } = await supabase
        .from('agent_tasks' as any)
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          error: 'Cancelled by user from Code Workspace',
        } as any)
        .eq('id', taskId);

      if (error) throw error;
      toast.info('Task cancelled — agent will stop at next checkpoint');
    } catch (err) {
      toast.error('Failed to cancel task');
      console.error('[useCodeWorkspace] cancelTask error:', err);
    }
  }, []);

  return {
    projects,
    sessions,
    activeProject,
    activeSession,
    fileTree,
    selectedFile,
    selectedFileContent,
    fileLoading,
    terminalLogs,
    chatMessages,
    loading,
    sending,
    addProject,
    removeProject,
    selectProject,
    setSelectedFile,
    sendCodeCommand,
    loadFileContent,
    cancelTask,
  };
}
