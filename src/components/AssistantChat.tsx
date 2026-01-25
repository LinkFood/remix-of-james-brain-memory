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
  MessageSquare,
  Send,
  Loader2,
  ChevronUp,
  ChevronDown,
  X,
  Sparkles,
  FileText,
  Volume2,
  VolumeX,
  Mic,
  MicOff,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { supabase } from "@/integrations/supabase/client";
import { retryWithBackoff } from "@/lib/retryWithBackoff";
import { useIsMobile } from "@/hooks/use-mobile";

// Web Speech API types (browser-specific, not in TypeScript lib)
interface WebSpeechRecognitionEvent {
  results: { [index: number]: { [index: number]: { transcript: string } } };
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
  start: () => void;
  stop: () => void;
}

interface Source {
  id: string;
  title: string | null;
  content_type: string;
  similarity?: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

interface AssistantChatProps {
  userId: string;
  onEntryCreated?: (entry: any) => void;
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
}

const suggestedQueries = [
  "What's on my list?",
  "What did I dump today?",
  "Find code about...",
  "Summarize my ideas",
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

const AssistantChat = ({ userId, onEntryCreated, externalOpen, onExternalOpenChange }: AssistantChatProps) => {
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

  const isMobile = useIsMobile();

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
    if (!text || isSpeaking || ttsLoading) {
      console.log('[Jac TTS] Skipping - already speaking or loading');
      return;
    }

    console.log('[Jac TTS] Starting speech for:', text.substring(0, 50) + '...');
    
    try {
      setTtsLoading(true);
      setIsSpeaking(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      console.log('[Jac TTS] Calling TTS endpoint...');
      
      const response = await retryWithBackoff(
        async () => {
          const res = await fetchWithTimeout(TTS_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ text }),
          });

          console.log('[Jac TTS] Response status:', res.status);

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error('[Jac TTS] Error response:', errorData);
            throw new Error(errorData.error || "Speech generation failed");
          }
          return res;
        },
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          toastId: "jac-tts-retry",
          showToast: true,
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
      toast.error(error.message || "Failed to speak");
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
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

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
      
      console.log('[Jac STT] Browser speech result:', transcript);
    };

    recognition.onerror = (event: WebSpeechRecognitionErrorEvent) => {
      console.error('[Jac STT] Browser speech error:', event.error);
      pendingTranscriptRef.current = null; // Clear on error - no auto-send
      if (event.error === 'not-allowed') {
        toast.error("Microphone access denied");
      } else if (event.error === 'no-speech') {
        toast.error("No speech detected. Try again.");
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
      
      // Auto-send if we have a transcript - mark as voice input
      const transcript = pendingTranscriptRef.current;
      if (transcript && transcript.trim()) {
        console.log('[Jac STT] Auto-sending transcript:', transcript.trim());
        lastInputWasVoiceRef.current = true; // Mark for auto-speak
        setTimeout(() => {
          handleSend(transcript.trim());
        }, 100);
      }
      pendingTranscriptRef.current = null;
    };

    try {
      recognition.start();
      setVoiceState('listening');
      setIsRecording(true);
      toast.info("Listening... Speak now");
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

  const handleSend = async (messageText?: string) => {
    const text = messageText || input.trim();
    if (!text || loading) return;

    const userMessage: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    // Add placeholder assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "", sources: [] }]);

    let finalContent = "";

    try {
      // Get fresh session - force refresh if token might be stale
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !session) {
        // Session is invalid, try to refresh
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !refreshData.session) {
          toast.error("Session expired. Please sign in again.");
          await supabase.auth.signOut();
          return;
        }
      }
      
      // Get the current session after potential refresh
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      if (!currentSession) {
        toast.error("Not authenticated. Please sign in.");
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
            }),
          });

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            // Handle auth errors specifically - don't retry, sign out
            if (res.status === 401) {
              toast.error("Session expired. Please sign in again.");
              await supabase.auth.signOut();
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

            // Check if this is our sources event
            if (parsed.sources) {
              sources = parsed.sources;
              // Update the message with sources
              setMessages((prev) => {
                const newMessages = [...prev];
                const lastIdx = newMessages.length - 1;
                if (newMessages[lastIdx]?.role === "assistant") {
                  newMessages[lastIdx] = { ...newMessages[lastIdx], sources };
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
            <Sparkles className="w-8 h-8 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              I'm Jac. I know everything in your brain dump. Ask me anything!
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
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm">Jac is thinking...</span>
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

              {/* Sources */}
              {msg.sources && msg.sources.length > 0 && (
                <div className="mt-2 pt-2 border-t border-border/50">
                  <p className="text-xs text-muted-foreground mb-1">
                    Sources:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {msg.sources.slice(0, 3).map((source) => (
                      <Badge
                        key={source.id}
                        variant="secondary"
                        className="text-xs"
                      >
                        <FileText className="w-3 h-3 mr-1" />
                        {source.title || source.content_type}
                      </Badge>
                    ))}
                    {msg.sources.length > 3 && (
                      <Badge variant="secondary" className="text-xs">
                        +{msg.sources.length - 3}
                      </Badge>
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
    return (
      <Button
        onClick={toggleOpen}
        className={cn(
          "fixed z-50 rounded-full shadow-lg",
          isMobile 
            ? "bottom-20 right-4 h-14 w-14" // Above mobile nav
            : "bottom-4 right-4 h-14 w-14"
        )}
        size="icon"
      >
        <MessageSquare className="w-6 h-6" />
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
                <div className="p-1.5 rounded-md bg-primary/10">
                  <Sparkles className="w-4 h-4 text-primary" />
                </div>
                <DrawerTitle className="text-base">Jac</DrawerTitle>
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

  // Desktop: Card (original behavior)
  return (
    <Card
      className={cn(
        "fixed bottom-4 right-4 z-50 transition-all duration-300 shadow-xl",
        isMinimized ? "w-72" : "w-96 h-[500px]"
      )}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 border-b cursor-pointer"
        onClick={toggleOpen}
      >
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-md bg-primary/10">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <span className="font-medium text-sm">Jac</span>
          {isSpeaking && (
            <Badge variant="secondary" className="text-xs animate-pulse">
              Speaking...
            </Badge>
          )}
          {ttsLoading && !isSpeaking && (
            <Badge variant="secondary" className="text-xs">
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
              Loading...
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
            Ask Jac about your brain dump...
          </p>
        </div>
      )}

      {/* Expanded state */}
      {!isMinimized && renderChatContent()}
    </Card>
  );
};

export default AssistantChat;
