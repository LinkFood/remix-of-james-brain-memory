/**
 * useClock — Returns current time string, updates every 60 seconds.
 */

import { useState, useEffect } from 'react';

function formatTime(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function useClock(): string {
  const [time, setTime] = useState(formatTime);

  useEffect(() => {
    // Align to the next minute boundary
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    const timeout = setTimeout(() => {
      setTime(formatTime());
      // Then tick every 60s
      const interval = setInterval(() => setTime(formatTime()), 60_000);
      return () => clearInterval(interval);
    }, msUntilNextMinute);

    return () => clearTimeout(timeout);
  }, []);

  return time;
}
