import { useCallback, useEffect, useRef, useState } from "react";

type RecorderState = "idle" | "recording" | "paused" | "stopped" | "error";

export interface RecorderResult {
  state: RecorderState;
  elapsedSeconds: number;
  volume: number;
  decibels: number;
  waveform: number[];
  audioBlob: Blob | null;
  error: string;
  start: (keepScreenAwake?: boolean, monitorOutput?: boolean) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  discard: () => void;
}

export function useRecorder(): RecorderResult {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [volume, setVolume] = useState(0);
  const [decibels, setDecibels] = useState(-60);
  const [waveform, setWaveform] = useState<number[]>(Array(48).fill(0));
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const keepScreenAwakeRef = useRef(false);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number | null>(null);
  const elapsedBeforePauseRef = useRef(0);
  const analyserFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const requestScreenWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator) || wakeLockRef.current) return;

    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      wakeLockRef.current.addEventListener("release", () => {
        wakeLockRef.current = null;
      });
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    keepScreenAwakeRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
    if (analyserFrameRef.current) cancelAnimationFrame(analyserFrameRef.current);
    analyserFrameRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }, []);

  const startVolumeMeter = useCallback((stream: MediaStream, monitorOutput = false) => {
    const AudioContextCtor =
      window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("AudioContext ist nicht verfügbar.");
    const audioContext = new AudioContextCtor();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.58;
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    if (monitorOutput) {
      const monitorGain = audioContext.createGain();
      monitorGain.gain.value = 0.85;
      source.connect(monitorGain);
      monitorGain.connect(audioContext.destination);
    }
    audioContext.resume().catch(() => undefined);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      const samples: number[] = [];
      const sampleStep = Math.max(1, Math.floor(data.length / 48));

      for (let index = 0; index < data.length; index += 1) {
        const normalized = (data[index] - 128) / 128;
        sumSquares += normalized * normalized;
        if (index % sampleStep === 0 && samples.length < 48) {
          samples.push(Math.max(-1, Math.min(1, normalized * 5)));
        }
      }

      const rms = Math.sqrt(sumSquares / data.length);
      const nextDecibels = Math.max(-60, Math.min(0, 20 * Math.log10(rms || 0.0001)));
      const visibleLevel = Math.min(100, Math.round(Math.sqrt(Math.min(1, rms * 9)) * 100));
      setDecibels(Math.round(nextDecibels));
      setVolume(visibleLevel);
      setWaveform(samples);
      analyserFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }, []);

  const start = useCallback(async (keepScreenAwake = true, monitorOutput = false) => {
    try {
      keepScreenAwakeRef.current = keepScreenAwake;
      setError("");
      setAudioBlob(null);
      chunksRef.current = [];
      setWaveform(Array(48).fill(0));
      setDecibels(-60);
      setVolume(0);
      const stream = await getPreferredMicrophoneStream();
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

      if (keepScreenAwake) await requestScreenWakeLock();

      recorder.start(1000);
      startedAtRef.current = Date.now();
      elapsedBeforePauseRef.current = 0;
      setElapsedSeconds(0);
      setState("recording");
      startVolumeMeter(stream, monitorOutput);
    } catch {
      setError("Mikrofonzugriff wurde verweigert oder ist nicht verfügbar.");
      setState("error");
      releaseStream();
    }
  }, [releaseStream, requestScreenWakeLock, startVolumeMeter]);

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
    setDecibels(-60);
    setWaveform(Array(48).fill(0));
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

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && state === "recording" && keepScreenAwakeRef.current) {
        void requestScreenWakeLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [requestScreenWakeLock, state]);

  useEffect(() => releaseStream, [releaseStream]);

  return { state, elapsedSeconds, volume, decibels, waveform, audioBlob, error, start, pause, resume, stop, discard };
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

async function getPreferredMicrophoneStream(): Promise<MediaStream> {
  const baseConstraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  };

  const initialStream = await navigator.mediaDevices.getUserMedia(baseConstraints);

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const preferredInput = findBuiltInMicrophone(devices);
    if (!preferredInput?.deviceId) return initialStream;

    const currentDeviceId = initialStream.getAudioTracks()[0]?.getSettings().deviceId;
    if (currentDeviceId === preferredInput.deviceId) return initialStream;

    const preferredStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: preferredInput.deviceId },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    initialStream.getTracks().forEach((track) => track.stop());
    return preferredStream;
  } catch {
    return initialStream;
  }
}

function findBuiltInMicrophone(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  if (!audioInputs.length) return undefined;

  const blockedTerms = ["bluetooth", "headset", "headphone", "airpods", "buds", "hands-free", "handsfree", "speaker"];
  const preferredTerms = ["default", "built-in", "builtin", "internal", "iphone", "ipad", "phone", "microphone", "mikrofon"];

  return (
    audioInputs.find((device) => {
      const label = device.label.toLowerCase();
      return preferredTerms.some((term) => label.includes(term)) && !blockedTerms.some((term) => label.includes(term));
    }) ??
    audioInputs.find((device) => {
      const label = device.label.toLowerCase();
      return !blockedTerms.some((term) => label.includes(term));
    }) ??
    audioInputs[0]
  );
}
