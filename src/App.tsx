import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject, type TouchEvent } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User as FirebaseUser
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { httpsCallable } from "firebase/functions";
import {
  Archive,
  CheckCircle2,
  ChevronLeft,
  Clipboard,
  Download,
  FileAudio,
  FileText,
  Globe2,
  Loader2,
  Menu,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Square,
  Target,
  Trash2,
  Upload,
  LogOut,
  User
} from "lucide-react";
import { createFallbackTitle, formatDateTime, formatDuration, statusLabel } from "./lib/format";
import { firebase } from "./lib/firebase";
import {
  createRecordingFromAudio,
  deleteRecording,
  exportRecordingToDropbox,
  generateElevenLabsSpeech,
  renameRecording,
  retryRecordingProcessing,
  translateRecordingText
} from "./lib/recordingRepository";
import { useRecorder } from "./hooks/useRecorder";
import { useRecordings } from "./hooks/useRecordings";
import type { DraftMetadata, Recording } from "./types";

type AccessState = {
  allowed: boolean;
  isAdmin: boolean;
  email: string;
};

type AllowedUser = {
  name: string;
  email: string;
};

type ElevenLabsVoice = {
  id: string;
  name: string;
  category?: string;
};

const demoUserId = "demo-user";
const supportedAudio = ".mp3,.wav,.m4a,.webm,.mp4,audio/*,video/mp4";
const defaultVoiceSettings = {
  voiceId: "JBFqnCBsd6RMkjVDRZzb",
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  speed: 1,
  bluetoothLatencyMs: 180,
  playbackGain: 1,
  equalizerLow: 0,
  equalizerMid: 0,
  equalizerHigh: 0,
  voicePreset: "male",
  summaryModel: "gpt-4.1-mini",
  languageVoices: {} as Record<string, string>
};

type PlaybackSettings = Pick<
  typeof defaultVoiceSettings,
  "bluetoothLatencyMs" | "playbackGain" | "equalizerLow" | "equalizerMid" | "equalizerHigh"
>;

const fallbackVoices: ElevenLabsVoice[] = [
  { id: "JBFqnCBsd6RMkjVDRZzb", name: "Standard maennlich" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Standard weiblich" }
];

const summaryModels = [
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4o", label: "GPT-4o" }
];
const europeanLanguages = [
  { code: "en", label: "Englisch" },
  { code: "fr", label: "Franzoesisch" },
  { code: "es", label: "Spanisch" },
  { code: "it", label: "Italienisch" },
  { code: "nl", label: "Niederlaendisch" },
  { code: "pl", label: "Polnisch" },
  { code: "pt", label: "Portugiesisch" },
  { code: "sv", label: "Schwedisch" },
  { code: "da", label: "Daenisch" },
  { code: "fi", label: "Finnisch" },
  { code: "no", label: "Norwegisch" },
  { code: "cs", label: "Tschechisch" },
  { code: "sk", label: "Slowakisch" },
  { code: "sl", label: "Slowenisch" },
  { code: "hr", label: "Kroatisch" },
  { code: "hu", label: "Ungarisch" },
  { code: "ro", label: "Rumaenisch" },
  { code: "bg", label: "Bulgarisch" },
  { code: "el", label: "Griechisch" },
  { code: "et", label: "Estnisch" },
  { code: "lv", label: "Lettisch" },
  { code: "lt", label: "Litauisch" },
  { code: "ga", label: "Irisch" },
  { code: "mt", label: "Maltesisch" },
  { code: "is", label: "Islaendisch" },
  { code: "uk", label: "Ukrainisch" },
  { code: "tr", label: "Tuerkisch" }
];
const tabs = ["Übersicht", "Aufgaben", "Beschlüsse", "Transkript", "Audio"] as const;
type AppMode = "recording" | "latest" | "archive" | "equalizer";

export function App() {
  const recorder = useRecorder();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const [authLoading, setAuthLoading] = useState(firebase.isConfigured);
  const [selectedId, setSelectedId] = useState<string>("");
  const [openClusterId, setOpenClusterId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Übersicht");
  const [mode, setMode] = useState<AppMode>("recording");
  const [metadata, setMetadata] = useState<DraftMetadata>(() => ({
    title: createFallbackTitle(),
    category: "",
    project: ""
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [savingProgress, setSavingProgress] = useState<number | null>(null);
  const [autoSaveAfterStop, setAutoSaveAfterStop] = useState(false);
  const [monitorOutput, setMonitorOutput] = useState(() => localStorage.getItem("voice-monitor-output") === "yes");
  const [recordingStartedAt, setRecordingStartedAt] = useState<Date>(() => new Date());
  const [notice, setNotice] = useState("");
  const [batteryDimmed, setBatteryDimmed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceSettings, setVoiceSettings] = useState(() => {
    try {
      return { ...defaultVoiceSettings, ...JSON.parse(localStorage.getItem("voice-elevenlabs-settings") || "{}") };
    } catch {
      return defaultVoiceSettings;
    }
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const userId = user?.uid ?? demoUserId;

  const { recordings, filtered, error, search, setSearch, statusFilter, setStatusFilter, sort, setSort } =
    useRecordings(userId);
  const latestRecording = useMemo(
    () => [...recordings].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0],
    [recordings]
  );
  const selected = useMemo(
    () => recordings.find((recording) => recording.id === selectedId) ?? latestRecording ?? filtered[0],
    [filtered, latestRecording, recordings, selectedId]
  );

  function openRecordingInPlayback(recording: Recording) {
    setSelectedId(recording.id);
    setOpenClusterId(recording.id);
    setMode("latest");
  }

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    localStorage.setItem("voice-elevenlabs-settings", JSON.stringify(voiceSettings));
  }, [voiceSettings]);

  useEffect(() => {
    localStorage.setItem("voice-monitor-output", monitorOutput ? "yes" : "no");
  }, [monitorOutput]);

  useEffect(() => {
    if (mode !== "recording" || settingsOpen || isSaving) return;
    if (recorder.state === "recording" || recorder.state === "paused") return;
    void recorder.prepare(monitorOutput);
  }, [isSaving, mode, monitorOutput, recorder.prepare, recorder.state, settingsOpen]);

  const batteryRecording = false;

  useEffect(() => {
    if (batteryRecording) {
      setBatteryDimmed(true);
      return undefined;
    }

    setBatteryDimmed(false);
    return undefined;
  }, [batteryRecording]);

  useEffect(() => {
    if (!batteryRecording || batteryDimmed) return undefined;
    const timer = window.setTimeout(() => setBatteryDimmed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [batteryDimmed, batteryRecording]);

  useEffect(() => {
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    themeMeta?.setAttribute("content", batteryDimmed ? "#020617" : "#000000");
  }, [batteryDimmed]);

  useEffect(() => {
    if (!firebase.auth) {
      setAuthLoading(false);
      return undefined;
    }

    return onAuthStateChanged(firebase.auth, async (currentUser) => {
      if (!currentUser) {
        setUser(null);
        setAccessState(null);
        setAuthLoading(false);
        return;
      }

      const email = currentUser.email?.trim().toLowerCase() ?? "";
      if (email === "kj_privat@yahoo.de") {
        const appSettings = await fetchAppSettings().catch(() => null);
        if (appSettings) setVoiceSettings(appSettings);
        setAccessState({ allowed: true, isAdmin: true, email });
        setUser(currentUser);
        setNotice("");
        setAuthLoading(false);
        return;
      }

      try {
        const access = await fetchAccessState();
        if (!access.allowed) {
          await signOut(firebase.auth!);
          setNotice("Diese E-Mail ist noch nicht freigegeben.");
          return;
        }
        const appSettings = await fetchAppSettings().catch(() => null);
        if (appSettings) setVoiceSettings(appSettings);
        setAccessState(access);
        setUser(currentUser);
      } catch {
        await signOut(firebase.auth!);
        setNotice("Zugriff konnte nicht geprueft werden.");
      } finally {
        setAuthLoading(false);
      }
    });
  }, []);

  async function saveBlob(blob: Blob, duration = recorder.elapsedSeconds, returnToList = true) {
    setIsSaving(true);
    setSavingProgress(2);
    setNotice("");
    try {
      const title = metadata.title.trim() || createFallbackTitle();
      const saved = await createRecordingFromAudio(blob, { ...metadata, title }, userId, duration, setSavingProgress);
      setSelectedId(saved.id);
      setSavingProgress(100);
      setNotice(saved.audioUrl ? "Aufnahme gespeichert. Transkript und Zusammenfassung können bei Bedarf erstellt werden." : "Aufnahme gespeichert.");
      if (returnToList) setMode("latest");
      recorder.discard();
      setMetadata({ title: createFallbackTitle(), category: "", project: "" });
    } catch {
      setNotice("Speichern fehlgeschlagen. Die Aufnahme bleibt lokal verfügbar, bitte erneut versuchen.");
    } finally {
      setIsSaving(false);
      window.setTimeout(() => setSavingProgress(null), 350);
    }
  }

  useEffect(() => {
    if (!autoSaveAfterStop || recorder.state !== "stopped" || !recorder.audioBlob || isSaving) return;
    setAutoSaveAfterStop(false);
    void saveBlob(recorder.audioBlob, recorder.elapsedSeconds, false);
  }, [autoSaveAfterStop, recorder.audioBlob, recorder.elapsedSeconds, recorder.state, isSaving]);

  async function handleRecorderPrimaryAction() {
    if (recorder.state === "recording" || recorder.state === "paused") {
      setAutoSaveAfterStop(true);
      recorder.stop();
      return;
    }

    const startedAt = new Date();
    setRecordingStartedAt(startedAt);
    setMetadata((current) => ({
      ...current,
      title: current.title.trim() ? current.title : createFallbackTitle(startedAt)
    }));
    await recorder.start(true, monitorOutput);
  }

  function goToNextPage() {
    if (settingsOpen) return;
    if (mode === "recording") {
      setMode("latest");
      if (latestRecording) {
        setSelectedId(latestRecording.id);
        setOpenClusterId(latestRecording.id);
      }
      return;
    }
    if (mode === "latest") setMode("archive");
  }

  function goToPreviousPage() {
    if (settingsOpen) return;
    if (mode === "archive") {
      setMode("latest");
      if (selected) openRecordingInPlayback(selected);
      return;
    }
    if (mode === "latest") setMode("recording");
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 70 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) return;

    if (deltaX < 0) goToNextPage();
    else goToPreviousPage();
  }

  async function handleImport(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    if (file.size > 250 * 1024 * 1024) {
      setNotice("Die Datei ist größer als 250 MB. Bitte vor dem Upload komprimieren oder teilen.");
      return;
    }
    await saveBlob(file, 0);
  }

  function jumpTo(seconds: number) {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    audioRef.current.play().catch(() => undefined);
  }

  async function copyProtocol(recording: Recording) {
    await navigator.clipboard.writeText(buildPlainTextProtocol(recording));
    setNotice("Protokoll wurde in die Zwischenablage kopiert.");
  }

  function downloadProtocol(recording: Recording, kind: "txt" | "doc") {
    const isDoc = kind === "doc";
    const content = isDoc ? buildHtmlProtocol(recording) : buildPlainTextProtocol(recording);
    const blob = new Blob([content], { type: isDoc ? "application/msword" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${recording.title}.${kind}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete(recording: Recording) {
    await deleteRecording(recording);
    setSelectedId("");
  }

  async function handleStartProcessing(recording: Recording, mode: "transcript" | "summary") {
    setNotice(mode === "transcript" ? "Transkript wird erstellt." : "Zusammenfassung wird erstellt.");
    await retryRecordingProcessing(recording.id, mode);
  }

  async function handleRename(recording: Recording, title: string) {
    await renameRecording(recording, title);
    setNotice("Name wurde gespeichert.");
  }

  async function handleGenerateSpeech(
    recording: Recording,
    kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
    targetLanguage = "en"
  ) {
    setNotice("ElevenLabs-Audio wird erstellt.");
    const audioUrl = await generateElevenLabsSpeech(recording, kind, targetLanguage, voiceSettings);
    setNotice("ElevenLabs-Audio ist fertig.");
    return audioUrl;
  }

  async function handleTranslate(recording: Recording, targetLanguage: string, source: "summary" | "transcript" = "summary") {
    setNotice("Übersetzung wird erstellt.");
    await translateRecordingText(recording, targetLanguage, source);
    setNotice("Übersetzung ist fertig.");
  }

  async function handleSaveAudioSettings(settings: typeof defaultVoiceSettings) {
    setVoiceSettings(settings);
    setNotice("Speichere Equalizer.");
    try {
      const savedSettings = await saveAppSettings(settings);
      setVoiceSettings(savedSettings);
      setNotice("Equalizer gespeichert.");
    } catch {
      setNotice("Equalizer konnte nicht gespeichert werden.");
    }
  }

  async function handleLogout() {
    if (!firebase.auth) return;
    await signOut(firebase.auth);
    setSelectedId("");
  }

  function revealBatteryMode() {
    setBatteryDimmed(false);
  }

  if (authLoading) {
    return (
      <main className="app-shell auth-shell">
        <div className="auth-card">
          <Loader2 className="spin" size={24} aria-hidden="true" />
          <p>Anmeldung wird geprüft.</p>
        </div>
      </main>
    );
  }

  if (firebase.auth && !user) {
    return <AuthScreen onNotice={setNotice} notice={notice} />;
  }

  return (
    <main
      className={`app-shell ${mode === "recording" && !settingsOpen ? "recorder-app-shell" : ""} ${mode !== "recording" && !settingsOpen ? "latest-app-shell" : ""} ${mode === "equalizer" && !settingsOpen ? "equalizer-app-shell" : ""} ${batteryRecording ? "battery-mode" : ""} ${batteryDimmed ? "battery-dimmed" : ""}`}
      onClick={revealBatteryMode}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {mode === "recording" && !settingsOpen ? null : (
        <header className="topbar">
          {mode === "latest" && !settingsOpen ? (
            <button className="topbar-nav-button" aria-label="Zurück zur Aufnahme" onClick={() => setMode("recording")}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
          ) : null}
          <div>
            <p className="eyebrow">Voice Recorder</p>
            <h1>{settingsOpen ? "Einstellungen" : mode === "latest" ? "Letzte Aufnahme" : mode === "archive" ? "Archiv" : "Equalizer"}</h1>
          </div>
          <div className="topbar-actions">
            <button className="user-pill" onClick={handleLogout}>
              <LogOut size={16} aria-hidden="true" />
              Abmelden
            </button>
          </div>
        </header>
      )}

      {settingsOpen && accessState?.isAdmin ? (
        <SettingsPanel
          settings={voiceSettings}
          onChange={setVoiceSettings}
          onClose={() => setSettingsOpen(false)}
          isAdmin={Boolean(accessState?.isAdmin)}
        />
      ) : null}

      {!settingsOpen && mode === "recording" ? (
        <section className="recording-view recorder-home">
          <div className="recorder-top-actions">
            <button
              className="recorder-icon-button"
              aria-label="Letzte Aufnahme öffnen"
              onClick={() => {
                setMode("latest");
                if (latestRecording) {
                  openRecordingInPlayback(latestRecording);
                }
              }}
            >
              <Menu size={22} aria-hidden="true" />
            </button>
            {accessState?.isAdmin ? (
              <button className="recorder-icon-button" aria-label="Einstellungen öffnen" onClick={() => setSettingsOpen(true)}>
                <Settings size={21} aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="recorder-brand">
            <AudioMark />
            <p>Voice Recorder</p>
          </div>

          <button
            className={`record-button ${recorder.state === "recording" ? "is-recording" : ""}`}
            type="button"
            aria-label={recorder.state === "recording" ? "Aufnahme stoppen" : "Aufnahme starten"}
            onClick={handleRecorderPrimaryAction}
            disabled={isSaving}
          />

          <div className="recording-status-copy">
            <strong className={recorder.state === "recording" ? "is-live" : ""}>
              {isSaving ? "Aufnahme wird gespeichert" : recorder.state === "recording" ? "Aufnahme läuft" : "Bereit zur Aufnahme"}
            </strong>
            <span>
              {isSaving
                ? "Bitte kurz warten, Upload und Verarbeitung werden vorbereitet"
                : recorder.state === "recording"
                ? "Tippe erneut auf den Button, um zu stoppen"
                : recorder.isMicrophoneReady
                ? "Mikrofon ist aktiv, Aufnahme kann gestartet werden"
                : "Mikrofon wird vorbereitet"}
            </span>
            {isSaving ? <SavingProgress value={savingProgress} /> : null}
          </div>

          <label className="monitor-output-toggle">
            <input
              type="checkbox"
              checked={monitorOutput}
              onChange={(event) => setMonitorOutput(event.target.checked)}
              disabled={recorder.state === "recording" || recorder.state === "paused" || isSaving}
            />
            <span>
              <strong>Externer Lautsprecher</strong>
              <small>{monitorOutput ? "Mikrofon wird live ausgegeben" : "Ausgabe ueber verbundenen Audioausgang"}</small>
            </span>
          </label>

          <div className="recording-meta-strip">
            <label className="recording-name-field">
              <span>Aufnahme-Name</span>
              <span className="recording-name-input-wrap">
                <input
                  value={metadata.title}
                  onChange={(event) => setMetadata((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Neues Gespräch"
                />
                <Pencil size={15} aria-hidden="true" />
              </span>
            </label>
            <div className="recording-date-field">
              <span>Datum & Uhrzeit</span>
              <strong>{formatRecorderDate(recordingStartedAt)}</strong>
            </div>
          </div>

          <div className="duration-panel">
            <span>Laufzeit</span>
            <strong>{formatDigitalDuration(recorder.elapsedSeconds)}</strong>
          </div>

          <section className="live-panel" aria-label="Amplitude live">
            <div className="live-panel-heading">
              <span>Amplitude (Live)</span>
            </div>
            <LiveWaveform values={recorder.waveform} />
          </section>

          <section className="live-panel" aria-label="Lautstärke live">
            <div className="live-panel-heading">
              <span>Lautstärke (Live)</span>
              <strong>{recorder.decibels} dB</strong>
            </div>
            <div className="level-meter" aria-hidden="true">
              <span style={{ width: `${recorder.volume}%` }} />
            </div>
            <div className="level-scale">
              <span>-60 dB</span>
              <span>-30 dB</span>
              <span>-12 dB</span>
              <span>0 dB</span>
            </div>
          </section>

          {recorder.error ? <p className="error-text recorder-error">{recorder.error}</p> : null}
        </section>
      ) : !settingsOpen ? (
        <section className={`workspace recordings-workspace ${mode === "latest" ? "latest-workspace" : "archive-workspace"}`}>
          {mode === "latest" ? (
            <section className="detail-panel clusters-panel latest-detail-panel">
              <div className="cluster-list">
                {selected ? (
                  <LatestRecordingDetail
                    key={selected.id}
                    recording={selected}
                    playbackSettings={voiceSettings}
                    onBack={() => setMode("recording")}
                    onDelete={() => handleDelete(selected)}
                    onRename={(title) => handleRename(selected, title)}
                    onRetry={(mode) => handleStartProcessing(selected, mode)}
                    onGenerateSpeech={(kind, targetLanguage) => handleGenerateSpeech(selected, kind, targetLanguage)}
                    onTranslate={(targetLanguage, source) => handleTranslate(selected, targetLanguage, source)}
                  />
                ) : (
                  <div className="empty-state">
                    <Mic size={40} aria-hidden="true" />
                    <h2>Noch keine Aufnahme</h2>
                    <p>Wische zurück oder starte eine neue Aufnahme.</p>
                  </div>
                )}
              </div>
            </section>
          ) : mode === "archive" ? (
            <section className="detail-panel archive-list-panel">
              {filtered.length ? (
                <div className="recording-list archive-only-list">
                  {filtered.map((recording) => (
                    <ArchiveRecordingItem
                      key={recording.id}
                      recording={recording}
                      isSelected={selected?.id === recording.id}
                      onOpen={() => openRecordingInPlayback(recording)}
                      onDelete={() => handleDelete(recording)}
                    />
                  ))}
                </div>
              ) : (
              <div className="empty-state">
                <Mic size={40} aria-hidden="true" />
                <h2>Noch keine Gespräche</h2>
                <p>Starten Sie eine Aufnahme oder importieren Sie eine Audiodatei.</p>
              </div>
              )}
            </section>
          ) : (
            <EqualizerScreen settings={voiceSettings} onChange={setVoiceSettings} onSave={handleSaveAudioSettings} />
          )}
        </section>
      ) : null}

      <nav className="bottom-nav" aria-label="App Navigation">
        <button
          className={mode === "recording" && !settingsOpen ? "is-active" : ""}
          onClick={() => {
            setSettingsOpen(false);
            setMode("recording");
          }}
        >
          <Mic size={20} aria-hidden="true" />
          Aufnahme
        </button>
        <button
          className={mode === "latest" && !settingsOpen ? "is-active" : ""}
          onClick={() => {
            setSettingsOpen(false);
            setMode("latest");
            if (!selectedId && latestRecording) openRecordingInPlayback(latestRecording);
          }}
        >
          <FileAudio size={20} aria-hidden="true" />
          Letzte
        </button>
        <button
          className={mode === "archive" && !settingsOpen ? "is-active" : ""}
          onClick={() => {
            setSettingsOpen(false);
            setMode("archive");
          }}
        >
          <Archive size={20} aria-hidden="true" />
          Archiv
        </button>
        <button
          className={mode === "equalizer" && !settingsOpen ? "is-active" : ""}
          onClick={() => {
            setSettingsOpen(false);
            setMode("equalizer");
          }}
        >
          <SlidersHorizontal className="equalizer-nav-icon" size={20} aria-hidden="true" />
          Equalizer
        </button>
        {accessState?.isAdmin ? (
          <button className={settingsOpen ? "is-active" : ""} onClick={() => setSettingsOpen((current) => !current)}>
            <Settings size={20} aria-hidden="true" />
            Einstellungen
          </button>
        ) : null}
      </nav>

      {(notice || error) && <p className="notice">{notice || error}</p>}
    </main>
  );
}

function AuthScreen({ onNotice, notice }: { onNotice: (message: string) => void; notice: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => onNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice, onNotice]);

  useEffect(() => {
    const invitedEmail = new URLSearchParams(window.location.search).get("invite");
    if (invitedEmail) setEmail(invitedEmail);
  }, []);

  useEffect(() => {
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousColor = themeMeta?.getAttribute("content") ?? "#000000";
    themeMeta?.setAttribute("content", "#000000");
    return () => themeMeta?.setAttribute("content", previousColor);
  }, []);

  async function submit(kind: "login" | "register") {
    if (!firebase.auth) return;
    setIsBusy(true);
    onNotice("");
    try {
      if (kind === "register") {
        await createUserWithEmailAndPassword(firebase.auth, email.trim(), password);
      } else {
        await signInWithEmailAndPassword(firebase.auth, email.trim(), password);
      }
    } catch (error) {
      onNotice(getAuthErrorMessage(error, kind));
    } finally {
      setIsBusy(false);
    }
  }

  async function resetPassword() {
    if (!firebase.auth) return;
    if (!email.trim()) {
      onNotice("Bitte zuerst die E-Mail-Adresse eintragen.");
      return;
    }

    setIsBusy(true);
    onNotice("");
    try {
      await sendPasswordResetEmail(firebase.auth, email.trim());
      onNotice("Passwort-Mail wurde verschickt. Bitte Postfach prüfen.");
    } catch (error) {
      onNotice(getAuthErrorMessage(error, "login"));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <main className="app-shell auth-shell">
      <section className="auth-card">
        <div className="auth-icon">
          <AudioMark />
        </div>
        <div>
          <p className="eyebrow">Voice Recorder</p>
          <h1>Anmelden</h1>
        </div>
        <label>
          E-Mail
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
          />
        </label>
        <label>
          Passwort
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Mindestens 6 Zeichen"
          />
        </label>
        <button className="primary-action wide-action" disabled={isBusy} onClick={() => submit("login")}>
          {isBusy ? <Loader2 className="spin" size={20} aria-hidden="true" /> : null}
          Einloggen
        </button>
        <button className="secondary-action wide-action" disabled={isBusy} onClick={() => submit("register")}>
          Konto erstellen
        </button>
        <button className="link-action" disabled={isBusy} onClick={resetPassword}>
          Passwort zurücksetzen
        </button>
      </section>
      {notice && <p className="notice">{notice}</p>}
    </main>
  );
}

function SettingsPanel({
  settings,
  onChange,
  onClose,
  isAdmin
}: {
  settings: typeof defaultVoiceSettings;
  onChange: (settings: typeof defaultVoiceSettings) => void;
  onClose: () => void;
  isAdmin: boolean;
}) {
  const [allowedUsers, setAllowedUsers] = useState<AllowedUser[]>([]);
  const [adminNotice, setAdminNotice] = useState("");
  const [voices, setVoices] = useState<ElevenLabsVoice[]>(fallbackVoices);
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const cleanUsers = allowedUsers
    .map((user) => ({ name: user.name.trim(), email: user.email.trim().toLowerCase() }))
    .filter((user) => user.email);
  const firstUser = cleanUsers[0];
  const firstInviteLink = firstUser?.email ? `${window.location.origin}?invite=${encodeURIComponent(firstUser.email)}` : "";

  useEffect(() => {
    if (!isAdmin) return;
    fetchAllowedUsers()
      .then((list) => setAllowedUsers(list.length ? list : [{ name: "", email: "" }]))
      .catch(() => setAdminNotice("Benutzerliste konnte nicht geladen werden."));
    fetchAppSettings()
      .then((appSettings) => {
        onChange({ ...settings, ...appSettings });
      })
      .catch(() => undefined);
    fetchElevenLabsVoices()
      .then((list) => setVoices(list.length ? list : fallbackVoices))
      .catch(() => {
        setVoices(fallbackVoices);
        setAdminNotice("ElevenLabs-Stimmen konnten nicht geladen werden.");
      });
  }, [isAdmin]);

  function update<K extends keyof typeof defaultVoiceSettings>(key: K, value: (typeof defaultVoiceSettings)[K]) {
    onChange({ ...settings, [key]: value });
  }

  function updateLanguageVoice(language: string, voiceId: string) {
    const nextVoices = { ...settings.languageVoices };
    if (voiceId) {
      nextVoices[language] = voiceId;
    } else {
      delete nextVoices[language];
    }
    onChange({ ...settings, languageVoices: nextVoices });
  }

  async function saveUsers() {
    setAdminNotice("Speichere Einstellungen.");
    try {
      const updatedSettings = settings;
      const savedSettings = await saveAppSettings(updatedSettings);
      onChange({ ...updatedSettings, ...savedSettings });
      const saved = await saveAllowedUsers(cleanUsers);
      setAllowedUsers(saved.length ? saved : [{ name: "", email: "" }]);
      setAdminNotice("Einstellungen gespeichert.");
    } catch {
      setAdminNotice("Einstellungen konnten nicht gespeichert werden.");
    }
  }

  function updateAllowedUser(index: number, patch: Partial<AllowedUser>) {
    setAllowedUsers((current) => current.map((user, itemIndex) => (itemIndex === index ? { ...user, ...patch } : user)));
  }

  function addAllowedUser() {
    setAllowedUsers((current) => [...current, { name: "", email: "" }]);
  }

  function removeAllowedUser(index: number) {
    setAllowedUsers((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index);
      return next.length ? next : [{ name: "", email: "" }];
    });
  }

  return (
    <section className="settings-panel">
      <div className="settings-header">
        <h2>Einstellungen</h2>
        <button className="ghost-action" onClick={onClose}>
          Schließen
        </button>
      </div>
      <section className="settings-foldout">
        <button
          className="section-toggle"
          onClick={() => setVoiceSettingsOpen((current) => !current)}
          aria-expanded={voiceSettingsOpen}
        >
          <h3>ElevenLabs und Stimmen</h3>
          <strong>{voiceSettingsOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {voiceSettingsOpen ? (
          <div className="settings-foldout-body">
            <label>
              Standardstimme
              <select value={settings.voiceId} onChange={(event) => update("voiceId", event.target.value)}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              ChatGPT-Modell fuer Zusammenfassung
              <select value={settings.summaryModel} onChange={(event) => update("summaryModel", event.target.value)}>
                {summaryModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <section className="language-voice-list">
              <h3>Stimmen pro Sprache</h3>
              {europeanLanguages.map((language) => (
                <label key={language.code}>
                  {language.label}
                  <select
                    value={settings.languageVoices[language.code] ?? ""}
                    onChange={(event) => updateLanguageVoice(language.code, event.target.value)}
                  >
                    <option value="">Standardstimme</option>
                    {voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </section>
            <SettingSlider
              label="Stabilitaet"
              value={settings.stability}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => update("stability", value)}
            />
            <SettingSlider
              label="Aehnlichkeit"
              value={settings.similarityBoost}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => update("similarityBoost", value)}
            />
            <SettingSlider
              label="Stil"
              value={settings.style}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => update("style", value)}
            />
            <SettingSlider
              label="Geschwindigkeit"
              value={settings.speed}
              min={0.7}
              max={1.2}
              step={0.05}
              onChange={(value) => update("speed", value)}
            />
          </div>
        ) : null}
      </section>
      {isAdmin ? (
        <section className="admin-users">
          <h3>Benutzerzugang</h3>
          <div className="allowed-user-list">
            {allowedUsers.map((user, index) => (
              <div className="allowed-user-row" key={index}>
                <label>
                  Name
                  <input value={user.name} onChange={(event) => updateAllowedUser(index, { name: event.target.value })} />
                </label>
                <label>
                  E-Mail
                  <input
                    type="email"
                    value={user.email}
                    onChange={(event) => updateAllowedUser(index, { email: event.target.value })}
                  />
                </label>
                <button className="ghost-icon" aria-label="Benutzer entfernen" onClick={() => removeAllowedUser(index)}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
          <div className="admin-actions">
            <button className="secondary-action" onClick={addAllowedUser}>
              <Plus size={18} aria-hidden="true" />
              Benutzer
            </button>
            <button className="primary-action" onClick={saveUsers}>
              Speichern
            </button>
          </div>
          {firstInviteLink ? (
            <div className="invite-box">
              <a href={firstInviteLink}>{firstInviteLink}</a>
              <a
                className="secondary-action"
                href={`mailto:${encodeURIComponent(firstUser.email)}?subject=${encodeURIComponent(
                  "Einladung Voice Recorder"
                )}&body=${encodeURIComponent(
                  `Hallo${firstUser.name ? ` ${firstUser.name}` : ""},\n\nhier ist dein Zugang zum Voice Recorder:\n${firstInviteLink}\n\nBitte Konto mit dieser E-Mail-Adresse erstellen oder einloggen.`
                )}`}
              >
                Einladung per Mail
              </a>
              <img
                alt="QR-Code fuer Einladungslink"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(
                  firstInviteLink
                )}`}
              />
            </div>
          ) : null}
          {adminNotice ? <p className="muted">{adminNotice}</p> : null}
        </section>
      ) : null}
    </section>
  );
}

function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const displayValue = step >= 1 ? value.toFixed(0) : value.toFixed(2);
  return (
    <label className="setting-slider">
      <span>
        {label}
        <strong>{displayValue}{unit}</strong>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function EqualizerScreen({
  settings,
  onChange,
  onSave
}: {
  settings: typeof defaultVoiceSettings;
  onChange: (settings: typeof defaultVoiceSettings) => void;
  onSave: (settings: typeof defaultVoiceSettings) => Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);

  function update<K extends keyof typeof defaultVoiceSettings>(key: K, value: (typeof defaultVoiceSettings)[K]) {
    onChange({ ...settings, [key]: value });
  }

  async function save() {
    setIsSaving(true);
    try {
      await onSave(settings);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="equalizer-screen">
      <section className="equalizer-hero">
        <SlidersHorizontal className="equalizer-hero-icon" size={28} aria-hidden="true" />
        <div>
          <p className="eyebrow">Audio</p>
          <h2>Equalizer</h2>
        </div>
      </section>
      <section className="equalizer-settings">
        <SettingSlider
          label="Bluetooth-Latenz"
          value={settings.bluetoothLatencyMs}
          min={0}
          max={500}
          step={10}
          unit=" ms"
          onChange={(value) => update("bluetoothLatencyMs", value)}
        />
        <SettingSlider
          label="Lautstaerke"
          value={settings.playbackGain}
          min={0.5}
          max={2}
          step={0.05}
          unit="x"
          onChange={(value) => update("playbackGain", value)}
        />
        <SettingSlider
          label="Bass"
          value={settings.equalizerLow}
          min={-12}
          max={12}
          step={1}
          unit=" dB"
          onChange={(value) => update("equalizerLow", value)}
        />
        <SettingSlider
          label="Mitten"
          value={settings.equalizerMid}
          min={-12}
          max={12}
          step={1}
          unit=" dB"
          onChange={(value) => update("equalizerMid", value)}
        />
        <SettingSlider
          label="Obenfrequenz"
          value={settings.equalizerHigh}
          min={-12}
          max={12}
          step={1}
          unit=" dB"
          onChange={(value) => update("equalizerHigh", value)}
        />
        <button className="primary-action wide-action" onClick={save} disabled={isSaving}>
          {isSaving ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
          Speichern
        </button>
      </section>
    </section>
  );
}

async function fetchAccessState(): Promise<AccessState> {
  if (!firebase.functions) return { allowed: true, isAdmin: false, email: "" };
  const getAccessState = httpsCallable<void, AccessState>(firebase.functions, "getAccessState");
  const result = await getAccessState();
  return result.data;
}

async function fetchAllowedEmails(): Promise<string[]> {
  if (!firebase.functions) return [];
  const getAllowedUsers = httpsCallable<void, { emails: string[] }>(firebase.functions, "getAllowedUsers");
  const result = await getAllowedUsers();
  return result.data.emails;
}

async function fetchAllowedUsers(): Promise<AllowedUser[]> {
  if (!firebase.functions) return [];
  const getAllowedUsers = httpsCallable<void, { users?: AllowedUser[]; emails: string[] }>(
    firebase.functions,
    "getAllowedUsers"
  );
  const result = await getAllowedUsers();
  return result.data.users ?? result.data.emails.map((email) => ({ name: "", email }));
}

async function saveAllowedUsers(users: AllowedUser[]): Promise<AllowedUser[]> {
  if (!firebase.functions) return users;
  const saveAllowedUsersCallable = httpsCallable<{ users: AllowedUser[] }, { users?: AllowedUser[]; emails: string[] }>(
    firebase.functions,
    "saveAllowedUsers"
  );
  const result = await saveAllowedUsersCallable({ users });
  return result.data.users ?? result.data.emails.map((email) => ({ name: "", email }));
}

async function fetchAppSettings(): Promise<typeof defaultVoiceSettings> {
  if (!firebase.functions) return defaultVoiceSettings;
  const getAppSettings = httpsCallable<void, Partial<typeof defaultVoiceSettings>>(firebase.functions, "getAppSettings");
  const result = await getAppSettings();
  return { ...defaultVoiceSettings, ...result.data };
}

async function saveAppSettings(settings: typeof defaultVoiceSettings): Promise<typeof defaultVoiceSettings> {
  if (!firebase.functions) return settings;
  const saveAppSettingsCallable = httpsCallable<
    { settings: typeof defaultVoiceSettings },
    Partial<typeof defaultVoiceSettings>
  >(firebase.functions, "saveAppSettings");
  const result = await saveAppSettingsCallable({ settings });
  return { ...defaultVoiceSettings, ...result.data };
}

async function fetchElevenLabsVoices(): Promise<ElevenLabsVoice[]> {
  if (!firebase.functions) return fallbackVoices;
  const getElevenLabsVoices = httpsCallable<void, { voices: ElevenLabsVoice[] }>(
    firebase.functions,
    "getElevenLabsVoices"
  );
  const result = await getElevenLabsVoices();
  return result.data.voices;
}

function LatestRecordingDetail({
  recording,
  playbackSettings,
  onDelete,
  onRename,
  onRetry,
  onGenerateSpeech,
  onTranslate
}: {
  recording: Recording;
  playbackSettings: PlaybackSettings;
  onBack: () => void;
  onDelete: () => void;
  onRename: (title: string) => Promise<void>;
  onRetry: (mode: "transcript" | "summary") => Promise<void> | void;
  onGenerateSpeech: (
    kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
    targetLanguage?: string
  ) => Promise<string>;
  onTranslate: (targetLanguage: string, source?: "summary" | "transcript") => Promise<void>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(recording.title);
  const [openPanel, setOpenPanel] = useState<"" | "transcript" | "summary" | "translation" | "export">("");
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [isTranslating, setIsTranslating] = useState(false);
  const summaryText = getRecordingSummaryText(recording);
  const translation =
    recording.translations?.[targetLanguage] ?? (targetLanguage === "en" ? recording.englishTranslation : "");
  const translationAudioUrl =
    recording.elevenLabsTranslationAudioUrls?.[targetLanguage] ??
    (targetLanguage === "en" ? recording.elevenLabsTranslationAudioUrl : undefined);

  useEffect(() => {
    setDraftTitle(recording.title);
  }, [recording.title]);

  async function shareRecording() {
    const shareText = `${recording.title}\n${formatDateTime(recording.createdAt)} · ${formatDuration(recording.duration)}`;
    if (navigator.share) {
      await navigator.share({ title: recording.title, text: shareText, url: recording.audioUrl || window.location.href }).catch(() => undefined);
      return;
    }
    await navigator.clipboard.writeText(recording.audioUrl || shareText);
  }

  async function translateSummary() {
    setIsTranslating(true);
    try {
      await onTranslate(targetLanguage, "summary");
      setOpenPanel("translation");
    } finally {
      setIsTranslating(false);
    }
  }

  return (
    <article className="latest-detail-screen">
      <section className="latest-recording-card">
        <div className="latest-recording-head">
          <div>
            <p className="latest-section-kicker">
              <span className={`status-dot status-${recording.status}`} />
              Aufnahme
            </p>
            {isRenaming ? (
              <label className="latest-rename-field">
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
              </label>
            ) : (
              <h2>{getCleanRecordingTitle(recording.title)}</h2>
            )}
            <span>{formatDateTime(recording.createdAt)}</span>
          </div>
          <em>{formatDuration(recording.duration)}</em>
        </div>

        <div className="latest-audio-stage">
          {recording.audioUrl ? (
            <RoundAudioToggle
              audioRef={audioRef}
              audioUrl={recording.audioUrl}
              label="Aufzeichnung"
              playbackSettings={playbackSettings}
            />
          ) : null}
          <AudioAmplitudeWaveform audioUrl={recording.audioUrl} audioRef={audioRef} />
          <div className="latest-audio-times">
            <span>00:00</span>
            <span>{formatDuration(recording.duration)}</span>
          </div>
          {recording.audioUrl ? (
            <audio ref={audioRef} src={recording.audioUrl} className="hidden-audio" />
          ) : null}
        </div>

        <p className={`audio-status ${recording.audioUrl ? "audio-status-ready" : `audio-status-${recording.status}`}`}>
          <CheckCircle2 size={15} aria-hidden="true" />
          {recording.audioUrl ? "Audio ist verfügbar." : statusLabel(recording.status)}
        </p>

        <div className="latest-card-actions">
          <button
            className="latest-action-button"
            onClick={async () => {
              if (isRenaming) await onRename(draftTitle);
              setIsRenaming((current) => !current);
            }}
          >
            <Pencil size={20} aria-hidden="true" />
            {isRenaming ? "Speichern" : "Bearbeiten"}
          </button>
          <button className="latest-action-button is-danger" onClick={onDelete}>
            <Trash2 size={20} aria-hidden="true" />
            Löschen
          </button>
          <button className="latest-action-button" onClick={shareRecording}>
            <Share2 size={20} aria-hidden="true" />
            Teilen
          </button>
        </div>
      </section>

      <section className="latest-panel-group">
        <p className="latest-group-label">Inhalte</p>
        <LatestContentRow
          icon={<FileText size={22} aria-hidden="true" />}
          title="Transkript"
          subtitle="Gespräch in Textform"
          isOpen={openPanel === "transcript"}
          onClick={() => setOpenPanel((current) => (current === "transcript" ? "" : "transcript"))}
          audioControl={
            <ElevenLabsControls
              audioUrl={recording.elevenLabsTranscriptAudioUrl}
              storageKey={`elevenlabs:${recording.id}:transcript`}
              playbackSettings={playbackSettings}
              onPrepare={
                recording.transcript.length
                  ? undefined
                  : async () => {
                      await onRetry("transcript");
                      setOpenPanel("transcript");
                      return "Transkript wird erstellt. Danach kann es vorgelesen werden.";
                    }
              }
              onGenerate={() => onGenerateSpeech("transcript")}
            />
          }
        >
          <LatestTranscriptBlock recording={recording} onCreate={() => onRetry("transcript")} />
        </LatestContentRow>
        <LatestContentRow
          icon={<Target size={22} aria-hidden="true" />}
          title="Zusammenfassung"
          subtitle="Wesentliche Inhalte auf einen Blick"
          isOpen={openPanel === "summary"}
          onClick={() => setOpenPanel((current) => (current === "summary" ? "" : "summary"))}
          audioControl={
            <ElevenLabsControls
              audioUrl={recording.elevenLabsSummaryAudioUrl}
              storageKey={`elevenlabs:${recording.id}:summary`}
              playbackSettings={playbackSettings}
              onPrepare={
                summaryText
                  ? undefined
                  : async () => {
                      await onRetry("summary");
                      setOpenPanel("summary");
                      return "Zusammenfassung wird erstellt. Danach kann sie vorgelesen werden.";
                    }
              }
              onGenerate={() => onGenerateSpeech("summary")}
            />
          }
        >
          {summaryText ? (
            <p>{summaryText}</p>
          ) : (
            <div className="lazy-processing-action">
              <p className="muted">Noch keine Zusammenfassung vorhanden.</p>
            </div>
          )}
        </LatestContentRow>
        <LatestContentRow
          icon={<Globe2 size={22} aria-hidden="true" />}
          title="Übersetzung"
          subtitle="In andere Sprache übersetzen"
          isOpen={openPanel === "translation"}
          onClick={() => setOpenPanel((current) => (current === "translation" ? "" : "translation"))}
          audioControl={
            <ElevenLabsControls
              audioUrl={translationAudioUrl}
              storageKey={`elevenlabs:${recording.id}:summaryTranslation:${targetLanguage}`}
              playbackSettings={playbackSettings}
              onPrepare={
                translation
                  ? undefined
                  : async () => {
                      if (!summaryText) return "Erst nach der Zusammenfassung verfügbar.";
                      await translateSummary();
                      setOpenPanel("translation");
                      return "Übersetzung wird erstellt. Danach kann sie vorgelesen werden.";
                    }
              }
              onGenerate={() => onGenerateSpeech("translation", targetLanguage)}
            />
          }
        >
          <LatestTranslationBlock recording={recording} targetLanguage={targetLanguage} />
        </LatestContentRow>
      </section>

      <section className="latest-panel-group">
        <p className="latest-group-label">Einstellungen</p>
        <div className="latest-setting-row">
          <span>Sprache für Übersetzung</span>
          <select value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
            {europeanLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="latest-panel-group">
        <p className="latest-group-label">Export</p>
        <LatestContentRow
          icon={<Download size={22} aria-hidden="true" />}
          title="Exportieren"
          subtitle="Audio, Transkript oder Zusammenfassung exportieren"
          isOpen={openPanel === "export"}
          onClick={() => setOpenPanel((current) => (current === "export" ? "" : "export"))}
        >
          <LatestExportControls recording={recording} />
        </LatestContentRow>
      </section>
    </article>
  );
}

function LatestContentRow({
  icon,
  title,
  subtitle,
  isOpen,
  onClick,
  audioControl,
  children
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  isOpen: boolean;
  onClick: () => void;
  audioControl?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`latest-content-item ${isOpen ? "is-open" : ""}`}>
      <div className="latest-content-row">
        <button className="latest-content-main" onClick={onClick} aria-expanded={isOpen}>
          <span className="latest-content-icon">{icon}</span>
          <span>
            <strong>{title}</strong>
            <small>{subtitle}</small>
          </span>
        </button>
        <span className="latest-content-trailing">{audioControl || <ChevronLeft className="forward" size={21} aria-hidden="true" />}</span>
      </div>
      {isOpen ? <div className="latest-content-body">{children}</div> : null}
    </div>
  );
}

function LatestTranscriptBlock({ recording, onCreate }: { recording: Recording; onCreate: () => Promise<void> | void }) {
  if (recording.errorMessage) {
    return (
      <>
        <p className="error-text">{recording.errorMessage}</p>
        {recording.audioUrl ? (
          <button className="secondary-action compact-action" onClick={onCreate}>
            Transkript erneut starten
          </button>
        ) : null}
      </>
    );
  }

  if (!recording.transcript.length) {
    return (
      <div className="lazy-processing-action">
        <p className="muted">
          {recording.status === "transcribing" || recording.status === "analyzing"
            ? "Das Transkript wird erstellt."
            : "Noch kein Transkript vorhanden."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="transcript-actions">
        <button className="secondary-action compact-action" onClick={onCreate}>
          Sprecher neu erkennen
        </button>
      </div>
      <div className="transcript-lines">
        {recording.transcript.map((segment) => (
          <p key={segment.id}>
            <time>{formatDuration(segment.start)}</time>
            <strong>{segment.speaker || "Sprecher 1"}</strong>
            <span>{segment.text}</span>
          </p>
        ))}
      </div>
    </>
  );
}

function LatestTranslationBlock({ recording, targetLanguage }: { recording: Recording; targetLanguage: string }) {
  const translation =
    recording.translations?.[targetLanguage] ?? (targetLanguage === "en" ? recording.englishTranslation : "");

  if (!translation) {
    return <p className="muted">Noch keine Übersetzung für diese Sprache vorhanden.</p>;
  }

  return <p>{stripSpeakerLabels(translation)}</p>;
}

function LatestExportControls({ recording }: { recording: Recording }) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState("");

  async function saveToDropbox() {
    setIsExporting(true);
    setExportNotice("");
    try {
      const result = await exportRecordingToDropbox(recording);
      setExportNotice(`In Dropbox gespeichert: ${result.folderPath}`);
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : "Dropbox-Export fehlgeschlagen.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="compact-control-grid">
      <button className="secondary-action" onClick={() => window.print()}>
        <FileText size={18} aria-hidden="true" />
        PDF
      </button>
      <button className="secondary-action" onClick={() => downloadDocument(recording, "doc")}>
        <Download size={18} aria-hidden="true" />
        Word
      </button>
      <button className="secondary-action" onClick={saveToDropbox} disabled={isExporting}>
        {isExporting ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Upload size={18} aria-hidden="true" />}
        Dropbox
      </button>
      {exportNotice ? <p className="muted">{exportNotice}</p> : null}
    </div>
  );
}

function AudioAmplitudeWaveform({
  audioUrl,
  audioRef
}: {
  audioUrl: string;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const [bars, setBars] = useState<number[]>(() => Array(54).fill(18));
  const [playedRatio, setPlayedRatio] = useState(0);

  useEffect(() => {
    let isCancelled = false;
    setPlayedRatio(0);

    async function analyzeAudio() {
      if (!audioUrl) {
        setBars(Array(54).fill(18));
        return;
      }

      try {
        const response = await fetch(audioUrl);
        const audioData = await response.arrayBuffer();
        const AudioContextCtor =
          window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) throw new Error("AudioContext ist nicht verfügbar.");
        const audioContext = new AudioContextCtor();
        const buffer = await audioContext.decodeAudioData(audioData.slice(0));
        await audioContext.close().catch(() => undefined);
        if (isCancelled) return;
        setBars(createAmplitudeBars(buffer, 54));
      } catch {
        if (!isCancelled) setBars(Array(54).fill(18));
      }
    }

    void analyzeAudio();
    return () => {
      isCancelled = true;
    };
  }, [audioUrl]);

  useEffect(() => {
    const player = audioRef.current;
    if (!player) return undefined;
    let frame = 0;

    const updatePlaybackPosition = () => {
      const duration = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : 0;
      setPlayedRatio(duration ? Math.min(1, Math.max(0, player.currentTime / duration)) : 0);
    };

    const tick = () => {
      updatePlaybackPosition();
      if (!player.paused && !player.ended) frame = requestAnimationFrame(tick);
    };

    const handlePlay = () => {
      cancelAnimationFrame(frame);
      tick();
    };
    const handlePause = () => {
      cancelAnimationFrame(frame);
      updatePlaybackPosition();
    };
    const handleEnded = () => {
      cancelAnimationFrame(frame);
      setPlayedRatio(0);
    };

    player.addEventListener("loadedmetadata", updatePlaybackPosition);
    player.addEventListener("timeupdate", updatePlaybackPosition);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("ended", handleEnded);
    updatePlaybackPosition();

    return () => {
      cancelAnimationFrame(frame);
      player.removeEventListener("loadedmetadata", updatePlaybackPosition);
      player.removeEventListener("timeupdate", updatePlaybackPosition);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("ended", handleEnded);
    };
  }, [audioRef, audioUrl]);

  const activeBar = Math.floor(playedRatio * bars.length);

  return (
    <div className="latest-waveform" aria-hidden="true">
      {bars.map((height, index) => (
        <span
          key={`${height}-${index}`}
          className={index <= activeBar && playedRatio > 0 ? "is-played" : ""}
          style={{ height: `${height}px` }}
        />
      ))}
    </div>
  );
}

function createAmplitudeBars(buffer: AudioBuffer, barCount: number) {
  const channelData = buffer.getChannelData(0);
  const samplesPerBar = Math.max(1, Math.floor(channelData.length / barCount));
  const rawBars = Array.from({ length: barCount }, (_, barIndex) => {
    const start = barIndex * samplesPerBar;
    const end = Math.min(channelData.length, start + samplesPerBar);
    let sumSquares = 0;

    for (let index = start; index < end; index += 1) {
      sumSquares += channelData[index] * channelData[index];
    }

    return Math.sqrt(sumSquares / Math.max(1, end - start));
  });
  const peak = Math.max(...rawBars, 0.001);

  return rawBars.map((value) => {
    const normalized = Math.pow(value / peak, 0.55);
    return Math.round(8 + normalized * 56);
  });
}

function getCleanRecordingTitle(title: string) {
  const cleaned = title.replace(/\b(vom\s*)?\d{2}\.\d{2}\.\d{4}\s+\d{1,2}:\d{2}$/i, "").trim();
  return cleaned || "Gespräch";
}

function RecordingCluster({
  recording,
  isOpen,
  onToggle,
  onDelete,
  onRename,
  onRetry,
  onGenerateSpeech,
  onTranslate
}: {
  recording: Recording;
  isOpen: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onRename: (title: string) => Promise<void>;
  onRetry: (mode: "transcript" | "summary") => Promise<void> | void;
  onGenerateSpeech: (
    kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
    targetLanguage?: string
  ) => Promise<string>;
  onTranslate: (targetLanguage: string, source?: "summary" | "transcript") => Promise<void>;
}) {
  const clusterAudioRef = useRef<HTMLAudioElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(recording.title);

  useEffect(() => {
    setDraftTitle(recording.title);
  }, [recording.title]);

  return (
    <article className={`recording-cluster ${isOpen ? "is-open" : ""}`}>
      <button className="cluster-summary" onClick={onToggle} aria-expanded={isOpen}>
        <span className={`status-dot status-${recording.status}`} />
        <span className="cluster-type-row">
          <p className="eyebrow">Aufnahme</p>
          <em className={`progress-pill progress-${recording.status}`}>{statusLabel(recording.status)}</em>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </span>
        <span className="cluster-title-row">
          <h2>
            <CompactRecordingTitle title={recording.title} />
          </h2>
          <span className="cluster-duration">{formatDuration(recording.duration)}</span>
        </span>
      </button>

      {isOpen ? (
        <div className="cluster-body">
          <section className="cluster-section">
            <AudioTools recording={recording} audioRef={clusterAudioRef} />
          </section>

          <div className="cluster-actions">
            {isRenaming ? (
              <label className="rename-field">
                Name
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
              </label>
            ) : null}
            <button
              className="secondary-action cluster-icon-action"
              aria-label={isRenaming ? "Namen speichern" : "Aufnahme umbenennen"}
              title={isRenaming ? "Speichern" : "Umbenennen"}
              onClick={async () => {
                if (isRenaming) {
                  await onRename(draftTitle);
                }
                setIsRenaming((current) => !current);
              }}
            >
              {isRenaming ? "Speichern" : <Pencil size={18} aria-hidden="true" />}
            </button>
            <button className="ghost-action" onClick={onDelete}>
              <Trash2 size={18} aria-hidden="true" />
              Löschen
            </button>
          </div>

          <section className="cluster-section">
            <SimpleTranscript
              recording={recording}
              onCreate={() => onRetry("transcript")}
              onGenerateSpeech={() => onGenerateSpeech("transcript")}
              onTranslate={(targetLanguage) => onTranslate(targetLanguage, "transcript")}
              onGenerateTranslationSpeech={(targetLanguage) => onGenerateSpeech("transcriptTranslation", targetLanguage)}
            />
          </section>

          <section className="cluster-section">
            <SimpleSummary
              recording={recording}
              onCreate={() => onRetry("summary")}
              onGenerateSpeech={() => onGenerateSpeech("summary")}
            />
          </section>

          <section className="cluster-section">
            <SimpleTranslation
              recording={recording}
              onTranslate={onTranslate}
              onGenerateSpeech={(targetLanguage) => onGenerateSpeech("translation", targetLanguage)}
            />
          </section>

          <section className="cluster-section">
            <SimpleExport recording={recording} />
          </section>
        </div>
      ) : null}
    </article>
  );
}

function ArchiveRecordingItem({
  recording,
  isSelected,
  onOpen,
  onDelete
}: {
  recording: Recording;
  isSelected: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    event.stopPropagation();
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: TouchEvent<HTMLDivElement>) {
    event.stopPropagation();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;

    if (deltaX < 0) setIsDeleteOpen(true);
    else setIsDeleteOpen(false);
  }

  return (
    <div
      className={`archive-swipe-row ${isDeleteOpen ? "is-delete-open" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <button className="archive-delete-action" onClick={onDelete} aria-label={`${recording.title} löschen`}>
        <Trash2 size={18} aria-hidden="true" />
        Löschen
      </button>
      <button
        className={`recording-card compact-card archive-swipe-card ${isSelected ? "is-selected" : ""}`}
        onClick={() => {
          if (isDeleteOpen) {
            setIsDeleteOpen(false);
            return;
          }
          onOpen();
        }}
      >
        <span className={`status-dot status-${recording.status}`} />
        <strong>{recording.title}</strong>
        <span>{formatDateTime(recording.createdAt)} · {formatDuration(recording.duration)}</span>
      </button>
    </div>
  );
}

function getAuthErrorMessage(error: unknown, kind: "login" | "register"): string {
  if (!(error instanceof FirebaseError)) {
    return "Anmeldung fehlgeschlagen. Bitte noch einmal versuchen.";
  }

  if (error.code === "auth/email-already-in-use") {
    return "Für diese E-Mail gibt es schon ein Konto. Bitte Einloggen drücken.";
  }

  if (error.code === "auth/weak-password") {
    return "Das Passwort muss mindestens 6 Zeichen haben.";
  }

  if (error.code === "auth/invalid-email") {
    return "Bitte eine gültige E-Mail-Adresse eingeben.";
  }

  if (error.code === "auth/configuration-not-found" || error.code === "auth/operation-not-allowed") {
    return "Firebase Login ist noch nicht fertig eingerichtet. Bitte in Firebase Authentication E-Mail/Passwort aktivieren und speichern.";
  }

  if (error.code === "auth/invalid-credential" || error.code === "auth/user-not-found" || error.code === "auth/wrong-password") {
    return kind === "login"
      ? "Login nicht möglich. Wenn das dein erster Start ist, bitte Konto erstellen drücken."
      : "Konto konnte nicht erstellt werden. Bitte E-Mail und Passwort prüfen.";
  }

  return "Anmeldung fehlgeschlagen. Bitte E-Mail und Passwort prüfen.";
}

function getRecorderStatusText(state: string, isSaving: boolean): string {
  if (isSaving) return "Upload läuft";
  if (state === "recording") return "Aufnahme läuft";
  if (state === "paused") return "Pausiert";
  if (state === "stopped") return "Bereit zum Hochladen";
  if (state === "error") return "Aufnahme nicht möglich";
  return "Bereit für die Aufnahme";
}

function formatDigitalDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatRecorderDate(value: Date): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
    .format(value)
    .replace(",", " ·");
}

function AudioMark() {
  return <img className="audio-mark" src="/logo-192.png" alt="" aria-hidden="true" />;
}

function LiveWaveform({ values }: { values: number[] }) {
  const points = values.length ? values : Array(48).fill(0);

  return (
    <div className="live-waveform" aria-hidden="true">
      <div className="waveform-zero-line" />
      {points.map((value, index) => {
        const height = Math.max(3, Math.round(Math.abs(value) * 128));
        return <span key={`${index}-${height}`} style={{ height: `${height}px` }} />;
      })}
    </div>
  );
}

function SavingProgress({ value }: { value: number | null }) {
  const progress = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const isIndeterminate = value === null;
  const isComplete = !isIndeterminate && progress >= 100;

  return (
    <div
      className={`saving-progress ${isIndeterminate ? "is-indeterminate" : ""} ${isComplete ? "is-complete" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="saving-progress-bar" aria-hidden="true">
        <span style={isIndeterminate ? undefined : { width: `${progress}%` }} />
      </div>
      <em>{isIndeterminate ? "Speichern läuft" : isComplete ? "Gespeichert" : `${progress}%`}</em>
    </div>
  );
}

function Overview({ recording }: { recording: Recording }) {
  const summaryText = getRecordingSummaryText(recording);
  return (
    <div className="content-grid">
      <section>
        <h3>Kurzfassung</h3>
        <p>{normalizeDisplayText(recording.shortSummary) || "Die KI-Auswertung steht noch aus."}</p>
      </section>
      <section>
        <h3>Zusammenfassung</h3>
        <p>{summaryText || "Noch keine ausführliche Zusammenfassung vorhanden."}</p>
      </section>
      <section>
        <h3>Teilnehmer</h3>
        <TagList items={recording.participants.length ? recording.participants : ["Noch nicht erkannt"]} />
      </section>
      <section>
        <h3>Themen</h3>
        <TagList items={recording.topics} empty="Noch keine Themen erkannt." />
      </section>
      <section>
        <h3>Termine</h3>
        <TagList items={recording.appointments} empty="Keine Termine erkannt." />
      </section>
      <section>
        <h3>Offene Fragen</h3>
        <TagList items={recording.questions} empty="Keine offenen Fragen erkannt." />
      </section>
      <section>
        <h3>Schlagwörter</h3>
        <TagList items={recording.keywords} empty="Noch keine Schlagwörter vorhanden." />
      </section>
    </div>
  );
}

function Tasks({ recording }: { recording: Recording }) {
  if (!recording.tasks.length) return <EmptyLine text="Keine Aufgaben erkannt." />;

  return (
    <div className="task-list">
      {recording.tasks.map((task) => (
        <article key={task.id} className="task-item">
          <CheckCircle2 size={20} aria-hidden="true" />
          <div>
            <strong>{task.description}</strong>
            <span>{task.owner || "Ohne Verantwortlichen"} · {task.dueDate || "Ohne Termin"}</span>
          </div>
          <em>{task.status === "in_progress" ? "in Bearbeitung" : task.status === "done" ? "erledigt" : "offen"}</em>
        </article>
      ))}
    </div>
  );
}

function Decisions({ recording }: { recording: Recording }) {
  if (!recording.decisions.length) return <EmptyLine text="Keine Beschlüsse erkannt." />;
  return (
    <ul className="simple-list">
      {recording.decisions.map((decision) => (
        <li key={decision}>{decision}</li>
      ))}
    </ul>
  );
}

function Transcript({ recording, onJump }: { recording: Recording; onJump: (seconds: number) => void }) {
  if (!recording.transcript.length) return <EmptyLine text="Das vollständige Transkript wird nach der Verarbeitung angezeigt." />;
  return (
    <div className="transcript">
      {recording.transcript.map((segment) => (
        <button key={segment.id} onClick={() => onJump(segment.start)}>
          <time>{formatDuration(segment.start)}</time>
          <strong>{segment.speaker}</strong>
          <span>{segment.text}</span>
        </button>
      ))}
    </div>
  );
}

function CompactRecordingTitle({ title }: { title: string }) {
  const match = title.match(/^(.*?)(\d{2}\.\d{2}\.\d{4})\s+(\d{1,2}:\d{2})$/);
  if (!match) return <>{title}</>;
  const label = match[1].trim().replace(/\s+vom$/i, "") || "Gespräch";

  return (
    <span className="compact-recording-title">
      <span>{label}</span>
      <span>{match[2]}</span>
      <span>{match[3]}</span>
    </span>
  );
}

function AudioTools({
  recording,
  audioRef
}: {
  recording: Recording;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="audio-tools">
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Aufzeichnung</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {recording.audioUrl ? (
          <RoundAudioToggle audioRef={audioRef} audioUrl={recording.audioUrl} label="Aufzeichnung" />
        ) : null}
        <p className={`audio-status ${recording.audioUrl ? "audio-status-ready" : `audio-status-${recording.status}`}`}>
          {recording.audioUrl ? "Audio ist verfügbar." : statusLabel(recording.status)}
        </p>
      </div>
      {recording.audioUrl ? (
        <audio ref={audioRef} src={recording.audioUrl} className="hidden-audio" />
      ) : (
        <EmptyLine text="Audiodatei ist noch nicht verfügbar." />
      )}
    </div>
  );
}

function SimpleTranscript({
  recording,
  onCreate,
  onGenerateSpeech,
  onTranslate,
  onGenerateTranslationSpeech
}: {
  recording: Recording;
  onCreate: () => Promise<void> | void;
  onGenerateSpeech: () => Promise<string>;
  onTranslate: (targetLanguage: string) => Promise<void>;
  onGenerateTranslationSpeech: (targetLanguage: string) => Promise<string>;
}) {
  const transcriptText = recording.transcript.map((segment) => segment.text).join(" ");
  const [isOpen, setIsOpen] = useState(false);

  if (recording.errorMessage) {
    return (
      <section className="simple-transcript">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Transkript</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {isOpen ? (
          <>
        <p className="error-text">{recording.errorMessage}</p>
        {recording.audioUrl ? (
          <button className="secondary-action" onClick={onCreate}>
            Transkript erneut starten
          </button>
        ) : null}
          </>
        ) : null}
      </section>
    );
  }

  if (!recording.transcript.length) {
    return (
      <section className="simple-transcript">
        <div className="section-heading-row">
          <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
            <h3>Transkript</h3>
            <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
          </button>
          {recording.audioUrl && recording.status !== "transcribing" && recording.status !== "analyzing" ? (
            <ElevenLabsControls
              storageKey={`elevenlabs:${recording.id}:transcript`}
              onPrepare={async () => {
                await onCreate();
                setIsOpen(true);
                return "Transkript wird erstellt. Danach kann es vorgelesen werden.";
              }}
              onGenerate={onGenerateSpeech}
            />
          ) : null}
        </div>
        {isOpen ? (
          <div className="lazy-processing-action">
            <p className="muted">
              {recording.status === "transcribing" || recording.status === "analyzing"
                ? "Das Transkript wird erstellt."
                : "Noch kein Transkript vorhanden."}
            </p>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="simple-transcript">
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Transkript</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        <ElevenLabsControls
          audioUrl={recording.elevenLabsTranscriptAudioUrl}
          storageKey={`elevenlabs:${recording.id}:transcript`}
          onGenerate={onGenerateSpeech}
        />
      </div>
      {isOpen ? (
        <>
      <div className="transcript-actions">
        <button className="secondary-action compact-action" onClick={onCreate}>
          Sprecher neu erkennen
        </button>
      </div>
      <div className="transcript-lines">
        {recording.transcript.map((segment) => (
          <p key={segment.id}>
            <time>{formatDuration(segment.start)}</time>
            <strong>{segment.speaker || "Sprecher 1"}</strong>
            <span>{segment.text}</span>
          </p>
        ))}
      </div>
      <TranscriptTranslation
        recording={recording}
        onTranslate={onTranslate}
        onGenerateSpeech={onGenerateTranslationSpeech}
      />
        </>
      ) : null}
    </section>
  );
}

function SimpleSummary({
  recording,
  onCreate,
  onGenerateSpeech
}: {
  recording: Recording;
  onCreate: () => Promise<void> | void;
  onGenerateSpeech: () => Promise<string>;
}) {
  const summary = getRecordingSummaryText(recording);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="simple-summary">
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Zusammenfassung</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {recording.audioUrl && recording.status !== "transcribing" && recording.status !== "analyzing" ? (
            <ElevenLabsControls
              audioUrl={recording.elevenLabsSummaryAudioUrl}
              storageKey={`elevenlabs:${recording.id}:summary`}
              onPrepare={
                summary
                  ? undefined
                  : async () => {
                      await onCreate();
                      setIsOpen(true);
                      return "Zusammenfassung wird erstellt. Danach kann sie vorgelesen werden.";
                    }
              }
              onGenerate={onGenerateSpeech}
            />
        ) : null}
      </div>
      {isOpen ? (
        summary ? (
          <p>{summary}</p>
        ) : (
          <div className="lazy-processing-action">
            <p className="muted">
              {recording.status === "analyzing" || recording.status === "transcribing"
                ? "Die Zusammenfassung wird erstellt."
                : "Noch keine Zusammenfassung vorhanden."}
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}

function TranscriptTranslation({
  recording,
  onTranslate,
  onGenerateSpeech
}: {
  recording: Recording;
  onTranslate: (targetLanguage: string) => Promise<void>;
  onGenerateSpeech: (targetLanguage: string) => Promise<string>;
}) {
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const translation = recording.transcriptTranslations?.[targetLanguage] ?? "";
  const translationSegments = recording.transcriptTranslationSegments?.[targetLanguage] ?? [];
  const translationAudioUrl = recording.elevenLabsTranscriptTranslationAudioUrls?.[targetLanguage];
  const hasTranscript = Boolean(recording.transcript.length);

  async function translate() {
    setIsTranslating(true);
    try {
      await onTranslate(targetLanguage);
    } finally {
      setIsTranslating(false);
    }
  }

  return (
    <section className="transcript-translation">
      <div className="translation-controls translation-controls-top">
        <select
          aria-label="Zielsprache Transkript"
          value={targetLanguage}
          onChange={(event) => setTargetLanguage(event.target.value)}
        >
          {europeanLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Transkript uebersetzen</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {hasTranscript ? (
          <ElevenLabsControls
            audioUrl={translationAudioUrl}
            storageKey={`elevenlabs:${recording.id}:transcriptTranslation:${targetLanguage}`}
            onPrepare={
              translation
                ? undefined
                : async () => {
                    await translate();
                    setIsOpen(true);
                    return "Transkript-Übersetzung wird erstellt. Danach kann sie vorgelesen werden.";
                  }
            }
            onGenerate={() => onGenerateSpeech(targetLanguage)}
          />
        ) : null}
        <div className="translation-controls translation-controls-legacy">
          <select
            aria-label="Zielsprache Transkript"
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
          >
            {europeanLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isOpen && translation ? (
        <>
          {translationSegments.length ? (
            <div className="transcript-lines">
              {recording.transcript.map((segment, index) => (
                <p key={segment.id}>
                  <time>{formatDuration(segment.start)}</time>
                  <strong>{segment.speaker || "Sprecher 1"}</strong>
                  <span>{stripSpeakerLabels(translationSegments[index]?.text || "")}</span>
                </p>
              ))}
            </div>
          ) : (
            <p>{stripSpeakerLabels(translation)}</p>
          )}
        </>
      ) : isOpen ? (
        <p className="muted">
          {hasTranscript
            ? "Noch keine Transkript-Uebersetzung fuer diese Sprache vorhanden."
            : "Erst nach dem Transkript verfuegbar."}
        </p>
      ) : null}
    </section>
  );
}

function SimpleTranslation({
  recording,
  onTranslate,
  onGenerateSpeech
}: {
  recording: Recording;
  onTranslate: (targetLanguage: string) => Promise<void>;
  onGenerateSpeech: (targetLanguage: string) => Promise<string>;
}) {
  const [targetLanguage, setTargetLanguage] = useState("en");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const translation =
    recording.translations?.[targetLanguage] ?? (targetLanguage === "en" ? recording.englishTranslation : "");
  const translationAudioUrl =
    recording.elevenLabsTranslationAudioUrls?.[targetLanguage] ??
    (targetLanguage === "en" ? recording.elevenLabsTranslationAudioUrl : undefined);
  const hasSummary = Boolean(getRecordingSummaryText(recording));

  async function translate() {
    setIsTranslating(true);
    try {
      await onTranslate(targetLanguage);
    } finally {
      setIsTranslating(false);
    }
  }

  return (
    <section className="simple-translation">
      <div className="translation-controls translation-controls-top">
        <select
          aria-label="Zielsprache"
          value={targetLanguage}
          onChange={(event) => setTargetLanguage(event.target.value)}
        >
          {europeanLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </div>
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Uebersetzung</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {hasSummary ? (
          <ElevenLabsControls
            audioUrl={translationAudioUrl}
            storageKey={`elevenlabs:${recording.id}:summaryTranslation:${targetLanguage}`}
            onPrepare={
              translation
                ? undefined
                : async () => {
                    await translate();
                    setIsOpen(true);
                    return "Übersetzung wird erstellt. Danach kann sie vorgelesen werden.";
                  }
            }
            onGenerate={() => onGenerateSpeech(targetLanguage)}
          />
        ) : null}
        <div className="translation-controls translation-controls-legacy">
          <select
            aria-label="Zielsprache"
            value={targetLanguage}
            onChange={(event) => setTargetLanguage(event.target.value)}
          >
            {europeanLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {isOpen && translation ? (
        <p>{translation}</p>
      ) : isOpen ? (
        <p className="muted">
          {hasSummary
            ? "Noch keine Uebersetzung fuer diese Sprache vorhanden."
            : "Erst nach der Zusammenfassung verfuegbar."}
        </p>
      ) : null}
    </section>
  );
}

function ElevenLabsControls({
  audioUrl,
  storageKey: _storageKey,
  playbackSettings,
  onPrepare,
  onGenerate
}: {
  audioUrl?: string;
  storageKey: string;
  playbackSettings?: PlaybackSettings;
  onPrepare?: () => Promise<string | void>;
  onGenerate: () => Promise<string>;
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [localAudioUrl, setLocalAudioUrl] = useState(() => audioUrl ?? "");
  const [playbackHint, setPlaybackHint] = useState("");
  const elevenAudioRef = useRef<HTMLAudioElement>(null);
  const readyAudioUrl = localAudioUrl || audioUrl || "";

  useEffect(() => {
    setLocalAudioUrl(audioUrl ?? "");
  }, [audioUrl]);

  async function generate() {
    setIsGenerating(true);
    setPlaybackHint("");
    try {
      const prepareMessage = await onPrepare?.();
      if (prepareMessage) {
        setPlaybackHint(prepareMessage);
        return;
      }
      const generatedUrl = await onGenerate();
      if (!generatedUrl) {
        throw new Error("Keine ElevenLabs-Audiodatei erhalten.");
      }
      setLocalAudioUrl(generatedUrl);
      const player = elevenAudioRef.current;
      if (player) {
        player.src = generatedUrl;
        player.volume = clampPlaybackVolume(playbackSettings?.playbackGain ?? 1);
        await player.play();
        setPlaybackHint("");
      } else {
        setPlaybackHint("Audio ist fertig.");
      }
    } catch (error) {
      setPlaybackHint(error instanceof Error ? error.message : "Audio konnte nicht erstellt werden.");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <div className="elevenlabs-controls">
      {readyAudioUrl ? (
        <div className="section-controls">
          <RoundAudioToggle
            audioRef={elevenAudioRef}
            audioUrl={readyAudioUrl}
            label="Vorlesen"
            playbackSettings={playbackSettings}
          />
        </div>
      ) : null}
      {!readyAudioUrl ? (
        <button
          className="secondary-action generate-audio-toggle"
          onClick={generate}
          disabled={isGenerating}
          aria-label="Audio erstellen"
          title="Audio erstellen"
        >
          {isGenerating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Play size={18} aria-hidden="true" />}
          <span>Audio erstellen</span>
        </button>
      ) : null}
      <audio
        ref={elevenAudioRef}
        src={readyAudioUrl || undefined}
        className="hidden-audio"
      />
      {playbackHint ? <p className="muted">{playbackHint}</p> : null}
    </div>
  );
}

function RoundAudioToggle({
  audioRef,
  audioUrl,
  label,
  playbackSettings
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  audioUrl: string;
  label: string;
  playbackSettings?: PlaybackSettings;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackGain = playbackSettings?.playbackGain ?? 1;

  useEffect(() => {
    const player = audioRef.current;
    if (!player) return undefined;
    player.volume = clampPlaybackVolume(playbackGain);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("ended", handleEnded);
    return () => {
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("ended", handleEnded);
    };
  }, [audioRef, playbackGain]);

  function toggle() {
    const player = audioRef.current;
    if (!player) return;
    if (isPlaying) {
      player.pause();
      player.currentTime = 0;
      setIsPlaying(false);
      return;
    }
    player.src = audioUrl;
    player.volume = clampPlaybackVolume(playbackGain);
    player.play().catch(() => setIsPlaying(false));
  }

  return (
    <button
      className={`round-audio-toggle ${isPlaying ? "is-playing" : ""}`}
      onClick={toggle}
      aria-label={isPlaying ? `${label} stoppen` : `${label} abspielen`}
      title={isPlaying ? "Stopp" : "Play"}
    >
      {isPlaying ? <Square size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
    </button>
  );
}

function SimpleExport({ recording }: { recording: Recording }) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  async function saveToDropbox() {
    setIsExporting(true);
    setExportNotice("");
    try {
      const result = await exportRecordingToDropbox(recording);
      setExportNotice(`In Dropbox gespeichert: ${result.folderPath}`);
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : "Dropbox-Export fehlgeschlagen.");
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <section className="simple-export">
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Export</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
      </div>
      {isOpen ? (
        <div className="compact-control-grid">
          <button className="secondary-action" onClick={() => window.print()}>
            <FileText size={18} aria-hidden="true" />
            PDF
          </button>
          <button className="secondary-action" onClick={() => downloadDocument(recording, "doc")}>
            <Download size={18} aria-hidden="true" />
            Word
          </button>
          <button className="secondary-action" onClick={saveToDropbox} disabled={isExporting}>
            {isExporting ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Upload size={18} aria-hidden="true" />}
            In Dropbox speichern
          </button>
          {exportNotice ? <p className="muted">{exportNotice}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function downloadDocument(recording: Recording, kind: "doc") {
  const blob = new Blob([buildHtmlProtocol(recording)], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${recording.title}.${kind}`;
  link.click();
  URL.revokeObjectURL(url);
}

function TagList({ items, empty = "Keine Einträge." }: { items: string[]; empty?: string }) {
  if (!items.length) return <EmptyLine text={empty} />;
  return (
    <div className="tag-list">
      {items.map((item) => (
        <span key={item}>{item}</span>
      ))}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="muted">{text}</p>;
}

function stripSpeakerLabels(text: string): string {
  return text
    .replace(/(?:^|\s)(?:speaker|sprecher)\s+[a-z0-9]+:\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function seek(audioRef: RefObject<HTMLAudioElement | null>, seconds: number) {
  if (!audioRef.current) return;
  audioRef.current.currentTime = Math.max(0, audioRef.current.currentTime + seconds);
}

function clampPlaybackVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function getRecordingSummaryText(recording: Recording): string {
  return normalizeDisplayText(recording.summary) || normalizeDisplayText(recording.shortSummary);
}

function normalizeDisplayText(value: unknown): string {
  if (typeof value === "string") return value === "[object Object]" ? "" : value.trim();
  if (Array.isArray(value)) return value.map((item) => normalizeDisplayText(item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = record.text ?? record.content ?? record.summary ?? record.description;
    if (preferred !== undefined) return normalizeDisplayText(preferred);
    return Object.values(record).map((item) => normalizeDisplayText(item)).filter(Boolean).join("\n");
  }
  return "";
}

function buildPlainTextProtocol(recording: Recording): string {
  return [
    recording.title,
    `Datum: ${formatDateTime(recording.createdAt)}`,
    `Teilnehmer: ${recording.participants.join(", ") || "Noch nicht erkannt"}`,
    "",
    "Zusammenfassung",
    getRecordingSummaryText(recording),
    "",
    "Aufgaben",
    ...recording.tasks.map((task) => `- ${task.description} | ${task.owner} | ${task.dueDate} | ${task.status}`),
    "",
    "Beschlüsse",
    ...recording.decisions.map((decision) => `- ${decision}`),
    "",
    "Termine",
    ...recording.appointments.map((appointment) => `- ${appointment}`),
    "",
    "Offene Fragen",
    ...recording.questions.map((question) => `- ${question}`)
  ].join("\n");
}

function buildHtmlProtocol(recording: Recording): string {
  return `<html><body><pre>${escapeHtml(buildPlainTextProtocol(recording))}</pre></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (match) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[match];
  });
}
