import { useCallback, useEffect, useRef, useState } from "react";

type RecorderState = "idle" | "recording" | "paused" | "stopped" | "error";

export interface RecorderResult {
  state: RecorderState;
  elapsedSeconds: number;
  volume: number;
  audioBlob: Blob | null;
  error: string;
  start: (keepScreenAwake?: boolean) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  discard: () => void;
}

export function useRecorder(): RecorderResult {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [volume, setVolume] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const analyserFrameRef = useRef<number | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    if (analyserFrameRef.current) cancelAnimationFrame(analyserFrameRef.current);
  }, []);

  const startVolumeMeter = useCallback((stream: MediaStream) => {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    const data = new Uint8Array(analyser.frequencyBinCount);
    source.connect(analyser);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      setVolume(Math.min(100, Math.round((average / 128) * 100)));
      analyserFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }, []);

  const start = useCallback(async (keepScreenAwake = true) => {
    try {
      setError("");
      setAudioBlob(null);
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        setAudioBlob(blob);
        setState("stopped");
        releaseStream();
      };

      if (keepScreenAwake && "wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      }

      recorder.start(1000);
      startedAtRef.current = Date.now();
      elapsedBeforePauseRef.current = 0;
      setElapsedSeconds(0);
      setState("recording");
      startVolumeMeter(stream);
    } catch {
      setError("Mikrofonzugriff wurde verweigert oder ist nicht verfügbar.");
      setState("error");
      releaseStream();
    }
  }, [releaseStream, startVolumeMeter]);

  const pause = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.pause();
      elapsedBeforePauseRef.current = elapsedSeconds;
      startedAtRef.current = null;
      setState("paused");
    }
  }, [elapsedSeconds]);

  const resume = useCallback(() => {
    if (recorderRef.current?.state === "paused") {
      recorderRef.current.resume();
      startedAtRef.current = Date.now();
      setState("recording");
    }
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const discard = useCallback(() => {
    chunksRef.current = [];
    setAudioBlob(null);
    setElapsedSeconds(0);
    setVolume(0);
    setState("idle");
    releaseStream();
  }, [releaseStream]);

  useEffect(() => {
    if (state !== "recording") return undefined;

    const timer = window.setInterval(() => {
      if (!startedAtRef.current) return;
      const liveSeconds = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsedSeconds(elapsedBeforePauseRef.current + liveSeconds);
    }, 250);

    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => releaseStream, [releaseStream]);

  return { state, elapsedSeconds, volume, audioBlob, error, start, pause, resume, stop, discard };
}

function getSupportedMimeType(): string {
  const candidates = [
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    ""
  ];
  return candidates.find((candidate) => !candidate || MediaRecorder.isTypeSupported(candidate)) ?? "";
}
