/**
 * useVoiceAlerts — speak new FLAGs / ALERTs out loud via browser TTS.
 *
 * Uses the Web Speech API (no API key, no cost). Subscribes to
 * ct_flags / ct_alerts INSERT events and reads the glance bullets aloud.
 * Can be toggled on/off; state persists in localStorage.
 * Rate-limited to one speak per 15s to avoid pile-ups during active flows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

const STORAGE_KEY = 'ct_voice_alerts_enabled';
const MIN_GAP_MS = 15_000;

type Payload = {
  _type: 'flag' | 'alert';
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  glance: string[] | null;
  alert_trigger?: string | null;
};

function composeSpeech(p: Payload): string {
  const prefix = p._type === 'alert' ? 'Alert' : 'Flag';
  const ticker = (p.instruments ?? []).join(' ');
  const dir = p.direction ? `, ${p.direction}` : '';
  const conv = p.conviction != null ? `, conviction ${p.conviction}` : '';
  const trig = p.alert_trigger ? `, ${p.alert_trigger.replace(/_/g, ' ')}` : '';
  const headline = `${prefix}: ${ticker}${dir}${conv}${trig}.`;
  const body = (p.glance ?? []).slice(0, 3).join('. ');
  return `${headline} ${body}`;
}

function speak(text: string) {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 1.0;
    u.volume = 1.0;
    // Prefer a neutral English voice
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => /en-US/i.test(v.lang) && /Samantha|Daniel|Google|Natural/i.test(v.name))
      ?? voices.find(v => /en-US/i.test(v.lang))
      ?? voices[0];
    if (preferred) u.voice = preferred;
    window.speechSynthesis.speak(u);
  } catch {
    /* ignore */
  }
}

export function useVoiceAlerts() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });
  const lastSpokenAt = useRef<number>(0);

  const setEnabledPersist = useCallback((v: boolean) => {
    setEnabled(v);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, v ? '1' : '0');
    }
  }, []);

  const speakNow = useCallback((payload: Payload) => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastSpokenAt.current < MIN_GAP_MS) return;
    lastSpokenAt.current = now;
    speak(composeSpeech(payload));
  }, [enabled]);

  // Subscribe to realtime inserts on ct_flags + ct_alerts
  useEffect(() => {
    if (!enabled) return;
    const chan = supabase
      .channel('ct_voice_alerts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_flags' }, (msg) => {
        const r = msg.new as Record<string, unknown>;
        if ((r.conviction as number | null) == null || (r.conviction as number) < 3) return;
        speakNow({
          _type: 'flag',
          instruments: (r.instruments as string[]) ?? [],
          direction: (r.direction as string) ?? null,
          conviction: (r.conviction as number) ?? null,
          horizon: (r.horizon as string) ?? null,
          glance: (r.glance as string[]) ?? null,
        });
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ct_alerts' }, (msg) => {
        const r = msg.new as Record<string, unknown>;
        speakNow({
          _type: 'alert',
          instruments: (r.instruments as string[]) ?? [],
          direction: (r.direction as string) ?? null,
          conviction: (r.conviction as number) ?? null,
          horizon: (r.horizon as string) ?? null,
          glance: (r.glance as string[]) ?? null,
          alert_trigger: (r.alert_trigger as string) ?? null,
        });
      })
      .subscribe();
    return () => { supabase.removeChannel(chan); };
  }, [enabled, speakNow]);

  const testSpeak = useCallback(() => {
    speak('Voice alerts on. Claude will read flags and alerts as they land.');
  }, []);

  return { enabled, setEnabled: setEnabledPersist, testSpeak };
}
