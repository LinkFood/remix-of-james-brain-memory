import { createRoot } from "react-dom/client";
import { initSentry } from "./lib/sentry";
import App from "./App.tsx";
import "./index.css";

// Initialize Sentry before rendering (only activates in production)
initSentry();

// Unregister any leftover service worker — it caches stale deploys
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) r.unregister();
  });
  caches.keys().then((names) => {
    for (const name of names) caches.delete(name);
  });
}

createRoot(document.getElementById("root")!).render(<App />);
