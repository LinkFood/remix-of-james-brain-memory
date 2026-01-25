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

const AssistantChat = ({ userId, onEntryCreated, externalOpen, onExternalOpenChange }: AssistantChatProps) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

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
          const res = await fetch(TTS_URL, {
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

  // Start voice recording
  const startRecording = useCallback(async () => {
    console.log('[Jac STT] Starting recording...');
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });

      console.log('[Jac STT] Got microphone access');

      // Try different mimeTypes for compatibility
      let mimeType = 'audio/webm';
      if (!MediaRecorder.isTypeSupported('audio/webm')) {
        mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported('audio/mp4')) {
          mimeType = 'audio/ogg';
        }
      }
      console.log('[Jac STT] Using mimeType:', mimeType);

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        console.log('[Jac STT] Data available:', event.data.size, 'bytes');
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        console.log('[Jac STT] Recording stopped, chunks:', audioChunksRef.current.length);
        stream.getTracks().forEach(track => track.stop());
        
        if (audioChunksRef.current.length === 0) {
          console.log('[Jac STT] No audio chunks recorded');
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        console.log('[Jac STT] Created blob:', audioBlob.size, 'bytes');
        await transcribeAudio(audioBlob);
      };

      mediaRecorder.start(1000); // Collect data every second
      setIsRecording(true);
      toast.info("Listening... Tap mic again when done");
    } catch (error: any) {
      console.error("[Jac STT] Recording error:", error);
      if (error.name === 'NotAllowedError') {
        toast.error("Microphone access denied. Please allow microphone access.");
      } else {
        toast.error("Could not access microphone");
      }
    }
  }, []);

  // Stop recording and transcribe
  const stopRecording = useCallback(() => {
    console.log('[Jac STT] Stopping recording...');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  // Transcribe audio using ElevenLabs STT
  const transcribeAudio = async (audioBlob: Blob) => {
    console.log('[Jac STT] Transcribing audio...');
    
    try {
      setLoading(true);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      console.log('[Jac STT] Calling STT endpoint...');
      
      const response = await retryWithBackoff(
        async () => {
          const res = await fetch(STT_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${session.access_token}`,
            },
            body: formData,
          });

          console.log('[Jac STT] Response status:', res.status);

          if (!res.ok) {
            const errorData = await res.json().catch(() => ({}));
            console.error('[Jac STT] Error response:', errorData);
            throw new Error(errorData.error || "Transcription failed");
          }
          return res;
        },
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          toastId: "jac-stt-retry",
          showToast: true,
        }
      );

      const { text } = await response.json();
      console.log('[Jac STT] Transcribed text:', text);

      if (text && text.trim()) {
        setInput(text.trim());
        // Don't auto-send, let user review first
        toast.success("Got it! Press send or edit your message");
        inputRef.current?.focus();
      } else {
        toast.error("Couldn't understand that. Try again.");
      }
    } catch (error: any) {
      console.error("[Jac STT] Error:", error);
      toast.error(error.message || "Transcription failed");
    } finally {
      setLoading(false);
    }
  };

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
      // Get user session token for proper authentication
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not authenticated");
      }

      const response = await retryWithBackoff(
        async () => {
          const res = await fetch(CHAT_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${session.access_token}`,
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

      // Auto-speak if enabled
      if (autoSpeak && finalContent) {
        speakText(finalContent);
      }

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

  // Floating button when closed
  if (!isOpen) {
    return (
      <Button
        onClick={toggleOpen}
        className="fixed bottom-4 right-4 h-14 w-14 rounded-full shadow-lg z-50"
        size="icon"
      >
        <MessageSquare className="w-6 h-6" />
      </Button>
    );
  }

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
        </div>
        <div className="flex items-center gap-1">
          {/* Auto-speak toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={(e) => {
              e.stopPropagation();
              setAutoSpeak(!autoSpeak);
              if (autoSpeak) {
                toast.info("Jac will stay quiet");
              } else {
                toast.info("Jac will speak responses");
              }
              if (isSpeaking) stopSpeaking();
            }}
            title={autoSpeak ? "Disable auto-speak" : "Enable auto-speak"}
          >
            {autoSpeak ? (
              <Volume2 className="w-4 h-4 text-primary" />
            ) : (
              <VolumeX className="w-4 h-4 text-muted-foreground" />
            )}
          </Button>
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
      {!isMinimized && (
        <>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3 h-[350px]">
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
          <div className="p-3 border-t">
            <div className="flex gap-2">
              {/* Voice input button */}
              <Button
                variant={isRecording ? "destructive" : "outline"}
                size="icon"
                className={cn("shrink-0", isRecording && "animate-pulse")}
                onClick={() => {
                  if (isRecording) {
                    stopRecording();
                  } else {
                    startRecording();
                  }
                }}
                disabled={loading}
                title={isRecording ? "Stop recording" : "Voice input"}
              >
                {isRecording ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </Button>
              <Input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={isRecording ? "Listening..." : "Ask Jac..."}
                disabled={loading || isRecording}
                className="text-sm"
              />
              <Button
                onClick={() => handleSend()}
                disabled={loading || !input.trim() || isRecording}
                size="icon"
                className="shrink-0"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        </>
      )}
    </Card>
  );
};

export default AssistantChat;
