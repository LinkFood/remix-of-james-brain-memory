/**
 * useVoiceInput - Speech recognition hook
 * 
 * Wraps the Web Speech API for voice-to-text input
 */

import { useState, useRef, useCallback } from "react";
import { toast } from "sonner";
import type { SpeechRecognition, SpeechRecognitionEvent } from "../types";

interface UseVoiceInputOptions {
  onTranscript: (transcript: string) => void;
  lang?: string;
}

interface UseVoiceInputReturn {
  isListening: boolean;
  isSupported: boolean;
  toggleVoice: () => void;
}

export function useVoiceInput({ onTranscript, lang = 'en-US' }: UseVoiceInputOptions): UseVoiceInputReturn {
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const isSupported = typeof window !== 'undefined' && 
    (!!window.SpeechRecognition || !!window.webkitSpeechRecognition);

  const toggleVoice = useCallback(() => {
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognitionAPI) {
      toast.error("Voice input not supported in this browser");
      return;
    }

    // Stop if already listening
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    // Start new recognition
    const recognition = new SpeechRecognitionAPI();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      onTranscript(transcript);
    };

    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    recognition.onerror = () => {
      setIsListening(false);
      recognitionRef.current = null;
      toast.error("Voice input failed. Please try again.");
    };

    recognition.start();
    setIsListening(true);
    toast.info("Listening... Speak now!");
  }, [isListening, lang, onTranscript]);

  return {
    isListening,
    isSupported,
    toggleVoice,
  };
}
