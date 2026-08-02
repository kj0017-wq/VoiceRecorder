/// <reference types="vite/client" />

interface WakeLockSentinel {
  release: () => Promise<void>;
}

interface WakeLock {
  request: (type: "screen") => Promise<WakeLockSentinel>;
}

interface Navigator {
  wakeLock?: WakeLock;
}
