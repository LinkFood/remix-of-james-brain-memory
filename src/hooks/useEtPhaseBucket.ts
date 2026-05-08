import { useEffect, useState } from 'react';

export type EtPhase = 'pre_open' | 'rth' | 'post_close';

const RTH_OPEN_UTC_HOUR = 13;
const RTH_OPEN_UTC_MINUTE = 30;
const RTH_CLOSE_UTC_HOUR = 20;
const RTH_CLOSE_UTC_MINUTE = 0;

function phaseFor(now: Date): EtPhase {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 'post_close';
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = RTH_OPEN_UTC_HOUR * 60 + RTH_OPEN_UTC_MINUTE;
  const close = RTH_CLOSE_UTC_HOUR * 60 + RTH_CLOSE_UTC_MINUTE;
  if (minutes < open) return 'pre_open';
  if (minutes >= close) return 'post_close';
  return 'rth';
}

export function useEtPhaseBucket(): EtPhase {
  const [phase, setPhase] = useState<EtPhase>(() => phaseFor(new Date()));

  useEffect(() => {
    const id = setInterval(() => {
      const next = phaseFor(new Date());
      setPhase((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  return phase;
}
