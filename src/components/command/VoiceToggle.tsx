/**
 * VoiceToggle — turn on browser TTS for live flag/alert readouts.
 * Free, no API key, uses the Web Speech API built into every browser.
 */
import { useVoiceAlerts } from '@/hooks/useVoiceAlerts';
import { Button } from '@/components/ui/button';
import { Volume2, VolumeX } from 'lucide-react';

export function VoiceToggle() {
  const { enabled, setEnabled, testSpeak } = useVoiceAlerts();

  return (
    <Button
      size="sm"
      variant={enabled ? 'default' : 'outline'}
      onClick={() => {
        if (!enabled) {
          setEnabled(true);
          testSpeak();
        } else {
          setEnabled(false);
        }
      }}
      title={enabled ? 'Voice alerts ON — flags & alerts read aloud as they land' : 'Voice alerts OFF'}
    >
      {enabled ? <Volume2 className="w-3.5 h-3.5 mr-1" /> : <VolumeX className="w-3.5 h-3.5 mr-1" />}
      {enabled ? 'Voice on' : 'Voice'}
    </Button>
  );
}
