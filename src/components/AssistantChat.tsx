/**
 * Jac — Your Brain's Voice
 * 
 * GOAL: "What was that thing..." → Found it.
 * 
 * This is Jac. Your personal assistant.
 * Jac only knows what YOU dumped. That's the point.
 * 
 * Show sources. Be fast. Stream responses. Speak back (optional).
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Send,
  Loader2,
  ChevronUp,
  ChevronDown,
  X,
  FileText,
  Volume2,
  VolumeX,
  Mic,
  MicOff,
  ExternalLink,
  CheckSquare,
  Expand,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { retryWithBackoff } from "@/lib/retryWithBackoff";
import { useIsMobile } from "@/hooks/use-mobile";
import { LinkJacBrainIcon } from "@/components/LinkJacLogo";
import { useSignedUrl } from "@/hooks/use-signed-url";
import { SourceImageGallery } from "@/components/chat/SourceImageGallery";
import { WebSourceCard, WebSource } from "@/components/chat/WebSourceCard";
import { Skeleton } from "@/components/ui/skeleton";
import { Globe } from "lucide-react";

// Web Speech API types (browser-specific, not in TypeScript lib)
interface WebSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { transcript: string; confidence: number };
}

interface WebSpeechRecognitionResultList {
  readonly length: number;
  [index: number]: WebSpeechRecognitionResult;
}

interface WebSpeechRecognitionEvent {
  results: WebSpeechRecognitionResultList;
}

interface WebSpeechRecognitionErrorEvent {
  error: string;
}

interface WebSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: WebSpeechRecognitionEvent) => void) | null;
  onerror: ((event: WebSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface Source {
  id: string;
  title: string | null;
  content: string;
  content_type: string;
  content_subtype?: string | null;
  tags: string[];
  importance_score?: number | null;
  created_at: string;
  event_date?: string | null;
  event_time?: string | null;
  list_items?: Array<{ text: string; checked: boolean }>;
  image_url?: string | null;
  similarity?: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  webSources?: WebSource[];
}

interface EntryContext {
  id: string;
  title?: string | null;
  content: string;
  content_type: string;
}

interface AssistantChatProps {
  userId: string;
  onEntryCreated?: (entry: any) => void;
  onViewEntry?: (entry: any) => void;
  onFilterByTag?: (tag: string) => void;
  onScrollToEntry?: (entryId: string) => void;
  onSelectEntries?: (entryIds: string[]) => void;
  /** Send a query to Jac's dashboard transformation engine */
  onJacDashboardQuery?: (query: string) => void;
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
  currentContext?: EntryContext | null;
  isEntryViewOpen?: boolean;
}

const suggestedQueries = [
  "What's on my list?",
  "What did I dump today?",
  "Find code about...",
  "Summarize my ideas",
];

/** Dashboard transformation queries — these trigger Jac's visual dashboard mode */
const dashboardQueries = [
  "What patterns am I missing?",
  "Show me connections in my brain",
  "What have I been thinking about?",
  "Find orphan entries with no links",
  "What have I forgotten about?",
  "Show me my most important items",
  "What's overdue?",
];

const CHAT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/assistant-chat`;
const TTS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-tts`;
const STT_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/elevenlabs-stt`;
const COLD_START_TIMEOUT = 30000; // 30 seconds for cold starts

// Helper to create fetch with timeout
const fetchWithTimeout = async (url: string, options: RequestInit, timeoutMs: number = COLD_START_TIMEOUT) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out - server may be starting up');
    }
    throw err;
  }
};

const STORAGE_KEY = 'jac-position';

const AssistantChat = ({ userId, onEntryCreated, onViewEntry, onFilterByTag, onScrollToEntry, onSelectEntries, onJacDashboardQuery, externalOpen, onExternalOpenChange, currentContext, isEntryViewOpen }: AssistantChatProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<WebSpeechRecognition | null>(null);
  const pendingTranscriptRef = useRef<string | null>(null);
  const lastInputWasVoiceRef = useRef<boolean>(false);
  const sessionExpiredRef = useRef<boolean>(false); // Prevent cascading auth failures

  // Draggable state
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);
  const hasDraggedRef = useRef(false);
  const lastTapRef = useRef<number>(0);

  const isMobile = useIsMobile();

  // Restore position from localStorage with strict validation
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 80;
        
        // Reject if not numbers, negative, or out of viewport
        if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number' ||
            parsed.x < 0 || parsed.y < 0 ||
            parsed.x > maxX || parsed.y > maxY) {
          localStorage.removeItem(STORAGE_KEY);
          setPosition({ x: 0, y: 0 });
        } else {
          setPosition(parsed);
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
        setPosition({ x: 0, y: 0 });
      }
    }
  }, []);

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    setIsDragging(true);
    hasDraggedRef.current = false;
    dragRef.current = {
      startX: clientX,
      startY: clientY,
      initialX: position.x,
      initialY: position.y
    };
  }, [position]);

  const handleDragMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDragging || !dragRef.current) return;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    
    const deltaX = clientX - dragRef.current.startX;
    const deltaY = clientY - dragRef.current.startY;
    
    // Mark as dragged if moved more than 5px
    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      hasDraggedRef.current = true;
    }
    
    // Calculate new position - positive values move away from default corner
    // Dragging left increases X (moves away from right edge)
    // Dragging up increases Y (moves away from bottom edge)
    const newX = dragRef.current.initialX + deltaX;
    const newY = dragRef.current.initialY + deltaY;
    
    // Clamp to valid bounds (0 = default corner, positive = moved away)
    const maxX = window.innerWidth - 80;  // Don't go past left edge
    const maxY = window.innerHeight - (isMobile ? 140 : 80);  // Account for mobile nav
    
    setPosition({
      x: Math.max(0, Math.min(maxX, newX)),
      y: Math.max(0, Math.min(maxY, newY))
    });
  }, [isDragging, isMobile]);

  const handleDragEnd = useCallback(() => {
    if (isDragging) {
      setIsDragging(false);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
    }
    dragRef.current = null;
  }, [isDragging, position]);

  // Attach global listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', handleDragMove);
      window.addEventListener('touchend', handleDragEnd);
      
      return () => {
        window.removeEventListener('mousemove', handleDragMove);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', handleDragMove);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, handleDragMove, handleDragEnd]);


  // Sync with external open state
  const isOpen = externalOpen !== undefined ? externalOpen : internalOpen;
  const setIsOpen = (open: boolean) => {
    if (onExternalOpenChange) {
      onExternalOpenChange(open);
    } else {
      setInternalOpen(open);
    }
  };

  // When external opens, expand
  useEffect(() => {
    if (externalOpen === true) {
      setIsMinimized(false);
    }
  }, [externalOpen]);

  useEffect(() => {
    if (isOpen && !isMinimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen, isMinimized]);

  useEffect(() => {
    if (isOpen && !isMinimized) {
      inputRef.current?.focus();
    }
  }, [isOpen, isMinimized]);

  // Speak text using ElevenLabs TTS
  const speakText = useCallback(async (text: string) => {
    // Skip if session is already expired (prevents cascading 401 errors)
    if (sessionExpiredRef.current) {
      console.log('[Jac TTS] Skipping - session already expired');
      return;
    }
    
    if (!text || isSpeaking || ttsLoading) {
      console.log('[Jac TTS] Skipping - already speaking or loading');
      return;
    }

    console.log('[Jac TTS] Starting speech for:', text.substring(0, 50) + '...');
    
    try {
      setTtsLoading(true);
      setIsSpeaking(true);

      console.log('[Jac TTS] Calling TTS endpoint...');
      
      const response = await retryWithBackoff(
        async () => {
          // Get fresh session INSIDE retry loop to handle token refresh
          const { data: { session } } = await supabase.auth.getSession();
          
          if (!session) {
            // Try to refresh the session
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError || !refreshData.session) {
              sessionExpiredRef.current = true;
              throw new Error("Session expired");
            }
          }
          
          // Get current session after potential refresh
          const { data: { session: currentSession } } = await supabase.auth.getSession();
          if (!currentSession) {
            sessionExpiredRef.current = true;
            throw new Error("Session expired");
          }
          
          const res = await fetchWithTimeout(TTS_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${currentSession.access_token}`,
            },
            body: JSON.stringify({ text }),
          });

          console.log('[Jac TTS] Response status:', res.status);

          // On 401, mark session as expired and don't retry
          if (res.status === 401) {
            console.log('[Jac TTS] 401 received - session expired');
            sessionExpiredRef.current = true;
            // IMPORTANT: server-side session may already be gone; ensure we clear locally.
            await supabase.auth.signOut({ scope: "local" }).catch(() => {});
            // Force user back to auth to acquire a fresh session
            window.location.assign("/auth");
            throw new Error("Session expired");
          }

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error('[Jac TTS] Error response:', errorData);
            throw new Error(errorData.error || "Speech generation failed");
          }
          return res;
        },
        {
          maxRetries: 2, // Reduced retries since we refresh token inside
          baseDelayMs: 500,
          toastId: "jac-tts-retry",
          showToast: false, // Don't show retry toasts for TTS
        }
      );

      const audioBlob = await response.blob();
      console.log('[Jac TTS] Got audio blob:', audioBlob.size, 'bytes');
      
      const audioUrl = URL.createObjectURL(audioBlob);
      
      // Stop any existing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        console.log('[Jac TTS] Audio playback ended');
        setIsSpeaking(false);
        setTtsLoading(false);
        URL.revokeObjectURL(audioUrl);
      };

      audio.onerror = (e) => {
        console.error('[Jac TTS] Audio playback error:', e);
        setIsSpeaking(false);
        setTtsLoading(false);
        URL.revokeObjectURL(audioUrl);
        toast.error("Failed to play audio");
      };

      await audio.play();
      console.log('[Jac TTS] Audio playing');
      setTtsLoading(false);
    } catch (error: any) {
      console.error("[Jac TTS] Error:", error);
      setIsSpeaking(false);
      setTtsLoading(false);
      // Don't show toast for session expired - already handled
      // For voice service issues, show a subtle message (not blocking)
      if (error.message !== "Session expired") {
        const msg = error.message || "Voice unavailable";
        // Only show toast for unexpected errors, not service unavailability
        if (!msg.includes("unavailable") && !msg.includes("API key")) {
          toast.error(msg);
        } else {
          console.log("[Jac TTS] Voice service unavailable - continuing silently");
        }
      }
    }
  }, [isSpeaking, ttsLoading]);

  // Stop speaking
  const stopSpeaking = useCallback(() => {
    console.log('[Jac TTS] Stopping speech');
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setIsSpeaking(false);
    setTtsLoading(false);
  }, []);

  // Voice state machine: 'idle' | 'listening' | 'transcribing'
  type VoiceState = 'idle' | 'listening' | 'transcribing';
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');

  // Check if browser supports SpeechRecognition
  const isSpeechSupported = typeof window !== 'undefined' && 
    (!!window.SpeechRecognition || !!window.webkitSpeechRecognition);

  // Browser-first voice input (matches Dump behavior)
  const startBrowserSpeech = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      toast.error("Voice input not supported in this browser");
      setVoiceState('idle');
      setIsRecording(false);
      return;
    }

    console.log('[Jac STT] Starting browser speech recognition');
    
    const recognition = new SpeechRecognition() as unknown as WebSpeechRecognition;
    recognitionRef.current = recognition;
    // Enable continuous mode so pauses don't cut off speech
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    // Track if audio capture has actually started
    let audioStarted = false;

    // Called when audio capture actually begins (mic is truly ready)
    recognition.onaudiostart = () => {
      audioStarted = true;
      console.log('[Jac STT] Audio capture started - NOW ready to speak');
      // Only now tell the user to speak
      toast.success("Speak now!", { duration: 2000 });
    };

    recognition.onresult = (event: WebSpeechRecognitionEvent) => {
      // Get the latest result
      const lastResultIndex = Object.keys(event.results).length - 1;
      const result = event.results[lastResultIndex];
      const transcript = result[0].transcript;
      
      // Update input with results for live feedback
      if (transcript && transcript.trim()) {
        setInput(transcript.trim());
        pendingTranscriptRef.current = transcript.trim();
      }
      
      console.log('[Jac STT] Browser speech result:', transcript, 'isFinal:', result.isFinal);
    };

    recognition.onerror = (event: WebSpeechRecognitionErrorEvent) => {
      console.error('[Jac STT] Browser speech error:', event.error);
      pendingTranscriptRef.current = null; // Clear on error - no auto-send
      if (event.error === 'not-allowed') {
        toast.error("Microphone access denied");
      } else if (event.error === 'no-speech') {
        // Only show if audio actually started (mic was active)
        if (audioStarted) {
          toast.error("No speech detected. Try again.");
        }
      } else if (event.error === 'aborted') {
        // User stopped, not an error
      } else {
        toast.error("Voice recognition failed");
      }
      setVoiceState('idle');
      setIsRecording(false);
    };

    recognition.onend = () => {
      console.log('[Jac STT] Browser speech ended');
      setVoiceState('idle');
      setIsRecording(false);
      recognitionRef.current = null;
      
      // Auto-send if we have a transcript - mark as voice input (immediate, no delay)
      const transcript = pendingTranscriptRef.current;
      if (transcript && transcript.trim()) {
        console.log('[Jac STT] Auto-sending transcript immediately:', transcript.trim());
        lastInputWasVoiceRef.current = true; // Mark for auto-speak
        // Send immediately - no delay needed
        handleSend(transcript.trim());
      }
      pendingTranscriptRef.current = null;
    };

    try {
      recognition.start();
      setVoiceState('listening');
      setIsRecording(true);
      // Show "preparing" first - "Speak now" will appear when onaudiostart fires
      toast.info("Preparing mic...", { duration: 1500 });
    } catch (err) {
      console.error('[Jac STT] Failed to start browser speech:', err);
      toast.error("Could not start voice recognition");
      setVoiceState('idle');
      setIsRecording(false);
    }
  }, []);

  // Stop voice input
  const stopVoice = useCallback(() => {
    console.log('[Jac STT] Stopping voice input');
    
    // Stop Web Speech recognition if active
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        // Ignore errors when stopping
      }
      recognitionRef.current = null;
    }
    
    // Stop MediaRecorder if active (legacy fallback)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    
    setVoiceState('idle');
    setIsRecording(false);
  }, []);

  // Toggle voice input - browser speech first (like Dump)
  const toggleVoice = useCallback(() => {
    if (voiceState !== 'idle' || isRecording) {
      // Stop if already active
      stopVoice();
      return;
    }

    // Use browser speech directly (matching Dump behavior)
    if (isSpeechSupported) {
      startBrowserSpeech();
    } else {
      toast.error("Voice input not supported in this browser");
    }
  }, [voiceState, isRecording, isSpeechSupported, startBrowserSpeech, stopVoice]);

  // Detect if a query should transform the dashboard (exploration/pattern queries)
  const isDashboardQuery = useCallback((text: string): boolean => {
    const dashboardPatterns = [
      /what (have i|am i|patterns|themes|connections|am i missing|should i)/i,
      /how (does this|do these|are .+ connected|do .+ relate)/i,
      /find (patterns|connections|themes|relationships|related)/i,
      /show me (connections|patterns|related|themes|what .+ connect)/i,
      /what('s| is) (the pattern|the connection|related|connected)/i,
      /connect.*(entries|dumps|notes|ideas)/i,
      /what.*(thinking about|working on|been dump)/i,
      /help me (understand|see|find pattern)/i,
      /surface|cluster|group|organize/i,
    ];
    return dashboardPatterns.some((p) => p.test(text));
  }, []);

  const handleSend = async (messageText?: string) => {
    const text = messageText || input.trim();
    if (!text || loading) return;

    // Check if this is a dashboard transformation query
    if (onJacDashboardQuery && isDashboardQuery(text)) {
      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");

      // Send to dashboard transformation engine
      onJacDashboardQuery(text);

      // Add a brief confirmation message in chat
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Check the dashboard — I'm showing you what I found." },
      ]);
      return;
    }

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    // Add placeholder assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "", sources: [], webSources: [] }]);

    let finalContent = "";

    try {
      // Get fresh session - force refresh if token might be stale
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !session) {
        // Session is invalid, try to refresh
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !refreshData.session) {
          sessionExpiredRef.current = true;
          toast.error("Session expired. Please sign in again.");
          await supabase.auth.signOut({ scope: "local" }).catch(() => {});
          window.location.assign("/auth");
          lastInputWasVoiceRef.current = false; // Don't try TTS
          return;
        }
      }
      
      // Session is valid - reset the expired flag
      sessionExpiredRef.current = false;
      
      // Get the current session after potential refresh
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      if (!currentSession) {
        sessionExpiredRef.current = true;
        toast.error("Not authenticated. Please sign in.");
        lastInputWasVoiceRef.current = false; // Don't try TTS
        return;
      }

      const response = await retryWithBackoff(
        async () => {
          const res = await fetchWithTimeout(CHAT_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${currentSession.access_token}`,
            },
            body: JSON.stringify({
              message: text,
              conversationHistory: messages.slice(-6).map((m) => ({
                role: m.role,
                content: m.content,
              })),
              stream: true,
              // Pass the current entry context if viewing one
              entryContext: currentContext ? {
                id: currentContext.id,
                title: currentContext.title,
                content: currentContext.content,
                content_type: currentContext.content_type,
              } : null,
            }),
          });

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            // Handle auth errors specifically - don't retry, sign out
            if (res.status === 401) {
              sessionExpiredRef.current = true;
              lastInputWasVoiceRef.current = false; // Don't try TTS
              toast.error("Session expired. Please sign in again.");
              await supabase.auth.signOut({ scope: "local" }).catch(() => {});
              window.location.assign("/auth");
              throw new Error("Session expired");
            }
            throw new Error(errorData.error || `Request failed: ${res.status}`);
          }
          return res;
        },
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          toastId: "jac-chat-retry",
          showToast: true,
        }
      );

      if (!response.body) {
        throw new Error("No response body");
      }

      // Read the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";
      let assistantContent = "";
      let sources: Source[] = [];
      let webSources: WebSource[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        textBuffer += decoder.decode(value, { stream: true });

        // Process line-by-line
        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line.startsWith(":") || line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);

            // Check if this is our sources event (brain sources and/or web sources)
            if (parsed.sources || parsed.webSources) {
              if (parsed.sources) sources = parsed.sources;
              if (parsed.webSources) webSources = parsed.webSources;
              // Update the message with sources
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIdx = newMessages.length - 1;
                if (newMessages[lastIdx]?.role === "assistant") {
                  newMessages[lastIdx] = { ...newMessages[lastIdx], sources, webSources };
                }
                return newMessages;
              });
              continue;
            }

            // Regular OpenAI-style streaming chunk
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              finalContent = assistantContent;
              // Update the last assistant message immutably
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIdx = newMessages.length - 1;
                if (newMessages[lastIdx]?.role === "assistant") {
                  newMessages[lastIdx] = {
                    ...newMessages[lastIdx],
                    content: assistantContent,
                    sources,
                    webSources,
                  };
                }
                return newMessages;
              });
            }
          } catch {
            // Incomplete JSON, put it back and wait
            textBuffer = line + "\n" + textBuffer;
            break;
          }
        }
      }

      // Final flush for any remaining buffer
      if (textBuffer.trim()) {
        for (let raw of textBuffer.split("\n")) {
          if (!raw) continue;
          if (raw.endsWith("\r")) raw = raw.slice(0, -1);
          if (raw.startsWith(":") || raw.trim() === "") continue;
          if (!raw.startsWith("data: ")) continue;
          const jsonStr = raw.slice(6).trim();
          if (jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              assistantContent += content;
              finalContent = assistantContent;
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIdx = newMessages.length - 1;
                if (newMessages[lastIdx]?.role === "assistant") {
                  newMessages[lastIdx] = {
                    ...newMessages[lastIdx],
                    content: assistantContent,
                    sources,
                    webSources,
                  };
                }
                return newMessages;
              });
            }
          } catch {
            // ignore
          }
        }
      }

      // Smart auto-speak: only speak if input was from voice
      if (lastInputWasVoiceRef.current && finalContent) {
        console.log('[Jac TTS] Voice input detected, speaking response');
        speakText(finalContent);
      }
      // Reset the voice flag for next interaction
      lastInputWasVoiceRef.current = false;

    } catch (error: any) {
      console.error("Jac error:", error);
      toast.error(error.message || "Failed to get response");
      // Update the placeholder message with error
      setMessages((prev) => {
        const newMessages = [...prev];
        const lastIdx = newMessages.length - 1;
        if (newMessages[lastIdx]?.role === "assistant") {
          newMessages[lastIdx] = {
            ...newMessages[lastIdx],
            content: "Sorry, I encountered an error. Please try again.",
          };
        }
        return newMessages;
      });
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleOpen = () => {
    if (!isOpen) {
      setIsOpen(true);
      setIsMinimized(false);
    } else if (isMinimized) {
      setIsMinimized(false);
    } else {
      setIsMinimized(true);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    setIsMinimized(true);
    stopSpeaking();
  };

  // Chat content (shared between mobile drawer and desktop card)
  const renderChatContent = () => (
    <>
      {/* Messages */}
      <div className={cn(
        "flex-1 overflow-y-auto p-3 space-y-3",
        isMobile ? "max-h-[60vh]" : "h-[350px]"
      )}>
        {messages.length === 0 && (
          <div className="text-center py-6">
            <LinkJacBrainIcon className="w-8 h-8 mx-auto text-sky-400/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              I'm Jac. I know everything in your LinkJac. Ask me anything!
            </p>
            <div className="flex flex-wrap gap-2 justify-center">
              {suggestedQueries.map((query) => (
                <Button
                  key={query}
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => handleSend(query)}
                >
                  {query}
                </Button>
              ))}
            </div>
            {onJacDashboardQuery && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <p className="text-xs text-muted-foreground/70 mb-2">
                  Dashboard insights:
                </p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {dashboardQueries.map((query) => (
                    <Button
                      key={query}
                      variant="outline"
                      size="sm"
                      className="text-xs border-sky-500/20 text-sky-400 hover:bg-sky-500/10"
                      onClick={() => handleSend(query)}
                    >
                      {query}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {messages.map((msg, index) => (
          <div
            key={index}
            className={cn(
              "flex",
              msg.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted"
              )}
            >
              {/* Show thinking indicator for empty assistant messages while streaming */}
              {msg.role === "assistant" && !msg.content && loading ? (
                <div className="space-y-2 py-1">
                  <div className="flex items-center gap-2 text-muted-foreground mb-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span className="text-xs">Jac is thinking...</span>
                  </div>
                  <Skeleton className="h-3 w-4/5" />
                  <Skeleton className="h-3 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              ) : (
                <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
              )}

              {/* Speak button for assistant messages */}
              {msg.role === "assistant" && msg.content && !loading && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 mt-1 text-xs"
                  onClick={() => {
                    if (isSpeaking) {
                      stopSpeaking();
                    } else {
                      speakText(msg.content);
                    }
                  }}
                  disabled={ttsLoading}
                  title={isSpeaking ? "Stop speaking" : "Have Jac speak this"}
                >
                  {ttsLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                  ) : isSpeaking ? (
                    <VolumeX className="w-3 h-3 mr-1" />
                  ) : (
                    <Volume2 className="w-3 h-3 mr-1" />
                  )}
                  {isSpeaking ? "Stop" : "Speak"}
                </Button>
              )}

              {/* Sources - with images and clickable badges */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  {/* Image gallery for sources with images */}
                  <SourceImageGallery 
                    sources={msg.sources}
                    userId={userId}
                    onViewEntry={onViewEntry}
                  />
                  
                  <p className="text-xs text-muted-foreground mb-1">
                    Sources (click to view):
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {msg.sources.slice(0, 3).map((source) => (
                      <div key={source.id} className="flex items-center gap-0.5">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-xs transition-colors",
                            onViewEntry && "cursor-pointer hover:bg-primary/20 hover:text-primary"
                          )}
                          onClick={() => {
                            if (onViewEntry && source.content) {
                              // Convert source to Entry format
                              const entryFromSource = {
                                id: source.id,
                                user_id: userId,
                                content: source.content,
                                title: source.title,
                                content_type: source.content_type,
                                content_subtype: source.content_subtype || null,
                                tags: source.tags || [],
                                extracted_data: {},
                                importance_score: source.importance_score ?? null,
                                list_items: source.list_items || [],
                                source: 'manual',
                                starred: false,
                                archived: false,
                                event_date: source.event_date || null,
                                event_time: source.event_time || null,
                                image_url: source.image_url || null,
                                created_at: source.created_at,
                                updated_at: source.created_at,
                              };
                              onViewEntry(entryFromSource);
                            }
                          }}
                        >
                          <FileText className="w-3 h-3 mr-1" />
                          {source.title || source.content_type}
                        </Badge>
                        {/* Scroll-to button */}
                        {onScrollToEntry && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-muted-foreground hover:text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              onScrollToEntry(source.id);
                            }}
                            title="Scroll to entry on dashboard"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                    {msg.sources.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{msg.sources.length - 3}
                      </Badge>
                    )}
                  </div>
                  
                  {/* Unique tags from sources - clickable to filter dashboard */}
                  {(() => {
                    const allTags = msg.sources?.flatMap(s => s.tags || []) || [];
                    const uniqueTags = [...new Set(allTags)].slice(0, 5);
                    if (uniqueTags.length === 0) return null;
                    
                    return (
                      <div className="mt-1.5 flex flex-wrap gap-1 items-center">
                        <span className="text-xs text-muted-foreground">Filter by:</span>
                        {uniqueTags.map((tag) => (
                          <Badge
                            key={tag}
                            variant="outline"
                            className="text-xs cursor-pointer hover:bg-accent transition-colors"
                            onClick={() => onFilterByTag?.(tag)}
                          >
                            #{tag}
                          </Badge>
                        ))}
                      </div>
                    );
                  })()}
                  
                  {/* Bulk select button when multiple sources */}
                  {msg.sources.length > 1 && onSelectEntries && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 text-xs w-full"
                      onClick={() => {
                        onSelectEntries(msg.sources!.map(s => s.id));
                      }}
                    >
                      <CheckSquare className="w-3 h-3 mr-1" />
                      Select {msg.sources.length} entries
                    </Button>
                  )}
                </div>
              )}

              {/* Web sources - external citations */}
              {msg.webSources && msg.webSources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground" />
                    <p className="text-xs text-muted-foreground">Web sources:</p>
                  </div>

                  <div className="space-y-1.5">
                    {msg.webSources.slice(0, 3).map((source, idx) => (
                      <WebSourceCard key={`${source.url}-${idx}`} source={source} />
                    ))}
                    {msg.webSources.length > 3 && (
                      <p className="text-xs text-muted-foreground pl-1">
                        +{msg.webSources.length - 3} more sources
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className={cn(
        "p-3 border-t",
        isMobile && "pb-safe"
      )}>
        <div className="flex gap-2">
          {/* Voice input button */}
          <Button
            variant={voiceState !== 'idle' ? "destructive" : "outline"}
            size="icon"
            className={cn(
              "shrink-0",
              voiceState === 'listening' && "animate-pulse",
              isMobile && "h-12 w-12" // Larger touch target on mobile
            )}
            onClick={toggleVoice}
            disabled={loading || voiceState === 'transcribing'}
            title={voiceState !== 'idle' ? "Stop listening" : "Voice input"}
          >
            {voiceState === 'transcribing' ? (
              <Loader2 className={cn("animate-spin", isMobile ? "w-5 h-5" : "w-4 h-4")} />
            ) : voiceState === 'listening' ? (
              <MicOff className={cn(isMobile ? "w-5 h-5" : "w-4 h-4")} />
            ) : (
              <Mic className={cn(isMobile ? "w-5 h-5" : "w-4 h-4")} />
            )}
          </Button>
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? "Listening..." : isTranscribing ? "Processing..." : "Ask Jac..."}
            disabled={loading || isRecording || isTranscribing}
            className={cn("text-sm", isMobile && "h-12 text-base")}
          />
          <Button
            onClick={() => handleSend()}
            disabled={loading || !input.trim() || isRecording || isTranscribing}
            size="icon"
            className={cn("shrink-0", isMobile && "h-12 w-12")}
          >
            {loading ? (
              <Loader2 className={cn("animate-spin", isMobile ? "w-5 h-5" : "w-4 h-4")} />
            ) : (
              <Send className={cn(isMobile ? "w-5 h-5" : "w-4 h-4")} />
            )}
          </Button>
        </div>
      </div>
    </>
  );

  // Floating button when closed
  if (!isOpen) {
    const handleFabClick = () => {
      // Double-tap detection for position reset
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        // Double-tap detected - reset position
        setPosition({ x: 0, y: 0 });
        localStorage.removeItem(STORAGE_KEY);
        toast.success("Jac returned to corner");
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;
      
      // Normal tap - open chat (if not dragged)
      if (!hasDraggedRef.current) {
        toggleOpen();
      }
    };
    
    return (
      <Button
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        onClick={handleFabClick}
        className={cn(
          "fixed z-[100] rounded-full shadow-lg bg-primary/10 hover:bg-primary/20 border border-primary/30 transition-transform",
          "h-16 w-16", // Bigger FAB
          isDragging ? "cursor-grabbing scale-105 opacity-90 shadow-2xl" : "cursor-grab"
        )}
        style={{
          right: `calc(1rem + ${position.x}px)`,
          bottom: isMobile ? `calc(5rem + ${position.y}px)` : `calc(1rem + ${position.y}px)`
        }}
        size="icon"
      >
        <LinkJacBrainIcon className="w-10 h-10" />
        {/* Context indicator - shows when viewing an entry */}
        {currentContext && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-primary rounded-full animate-pulse ring-2 ring-background" />
        )}
      </Button>
    );
  }

  // Mobile: Full-screen drawer (bottom sheet)
  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={setIsOpen}>
        <DrawerContent className="max-h-[85vh]">
          <DrawerHeader className="border-b pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-sky-400/10">
                  <LinkJacBrainIcon isThinking={loading || isTranscribing} className="w-5 h-5" />
                </div>
                <DrawerTitle className="text-base text-sky-400 font-bold">Jac</DrawerTitle>
                {isSpeaking && (
                  <Badge variant="secondary" className="text-xs animate-pulse">
                    Speaking...
                  </Badge>
                )}
                {isTranscribing && (
                  <Badge variant="secondary" className="text-xs">
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    Processing...
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Auto-speak toggle */}
                {/* Speaking indicator - shows when Jac is talking */}
                {isSpeaking && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    onClick={stopSpeaking}
                    title="Stop speaking"
                  >
                    <Volume2 className="w-5 h-5 text-primary animate-pulse" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  onClick={handleClose}
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>
            </div>
          </DrawerHeader>
          {renderChatContent()}
        </DrawerContent>
      </Drawer>
    );
  }

  // Desktop: Card (original behavior) - expands to right panel when viewing entry
  const isRightPanelMode = isEntryViewOpen && !isMinimized;
  
  return (
    <Card
      className={cn(
        "fixed z-[100] transition-all duration-300 shadow-xl",
        isMinimized ? "w-72" : "w-96 h-[500px]",
        // Full right-side panel mode when viewing an entry
        isRightPanelMode && "!w-[45vw] !h-[85vh] !right-4 !bottom-auto !top-[7.5vh]"
      )}
      style={isRightPanelMode ? undefined : {
        right: `calc(1rem + ${position.x}px)`,
        bottom: `calc(1rem + ${position.y}px)`
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 border-b cursor-pointer"
        onClick={toggleOpen}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="p-1.5 rounded-md bg-sky-400/10">
            <LinkJacBrainIcon isThinking={loading || isTranscribing} className="w-5 h-5" />
          </div>
          <span className="font-bold text-sm text-sky-400">Jac</span>
          {/* Context indicator - shows when Jac knows about current entry */}
          {currentContext && (
            <Badge variant="outline" className="text-xs max-w-[120px] truncate shrink-0 border-primary/30 text-primary/80">
              <FileText className="w-3 h-3 mr-1 shrink-0" />
              <span className="truncate">{currentContext.title || 'Viewing entry'}</span>
            </Badge>
          )}
          {isSpeaking && (
            <Badge variant="secondary" className="text-xs animate-pulse shrink-0">
              Speaking...
            </Badge>
          )}
          {ttsLoading && !isSpeaking && (
            <Badge variant="secondary" className="text-xs shrink-0">
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
              Loading...
            </Badge>
          )}
          {isTranscribing && (
            <Badge variant="secondary" className="text-xs shrink-0">
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
              Processing...
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Speaking indicator - shows when Jac is talking */}
          {isSpeaking && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => {
                e.stopPropagation();
                stopSpeaking();
              }}
              title="Stop speaking"
            >
              <Volume2 className="w-4 h-4 text-primary animate-pulse" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              toggleOpen();
            }}
          >
            {isMinimized ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              handleClose();
            }}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Minimized state */}
      {isMinimized && (
        <div className="p-3">
          <p className="text-xs text-muted-foreground">
            Ask Jac anything...
          </p>
        </div>
      )}

      {/* Expanded state */}
      {!isMinimized && renderChatContent()}
    </Card>
  );
};

export default AssistantChat;
