import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  Loader2,
  Mic,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Square,
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
  voicePreset: "male",
  summaryModel: "gpt-4.1-mini",
  languageVoices: {} as Record<string, string>
};

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

export function App() {
  const recorder = useRecorder();
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [accessState, setAccessState] = useState<AccessState | null>(null);
  const [authLoading, setAuthLoading] = useState(firebase.isConfigured);
  const [selectedId, setSelectedId] = useState<string>("");
  const [openClusterId, setOpenClusterId] = useState<string>("");
  const [allowScreenSleep, setAllowScreenSleep] = useState(
    () => localStorage.getItem("voice-allow-screen-sleep") === "yes"
  );
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("Übersicht");
  const [consentAccepted, setConsentAccepted] = useState(() => localStorage.getItem("voice-consent") === "yes");
  const [mode, setMode] = useState<"home" | "recording">("recording");
  const [metadata, setMetadata] = useState<DraftMetadata>(() => ({
    title: createFallbackTitle(),
    category: "",
    project: ""
  }));
  const [isSaving, setIsSaving] = useState(false);
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
  const userId = user?.uid ?? demoUserId;

  const { recordings, filtered, error, search, setSearch, statusFilter, setStatusFilter, sort, setSort } =
    useRecordings(userId);
  const selected = useMemo(
    () => recordings.find((recording) => recording.id === selectedId) ?? filtered[0],
    [filtered, recordings, selectedId]
  );

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    localStorage.setItem("voice-allow-screen-sleep", allowScreenSleep ? "yes" : "no");
  }, [allowScreenSleep]);

  useEffect(() => {
    localStorage.setItem("voice-elevenlabs-settings", JSON.stringify(voiceSettings));
  }, [voiceSettings]);

  const batteryRecording = allowScreenSleep && recorder.state === "recording";

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
    themeMeta?.setAttribute("content", batteryDimmed ? "#020617" : "#f8fafc");
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

  async function saveBlob(blob: Blob, duration = recorder.elapsedSeconds) {
    setIsSaving(true);
    setNotice("");
    try {
      const title = metadata.title.trim() || createFallbackTitle();
      const saved = await createRecordingFromAudio(blob, { ...metadata, title }, userId, duration);
      setSelectedId(saved.id);
      setNotice(saved.shortSummary);
      setMode("home");
      recorder.discard();
      setMetadata({ title: createFallbackTitle(), category: "", project: "" });
    } catch {
      setNotice("Speichern fehlgeschlagen. Die Aufnahme bleibt lokal verfügbar, bitte erneut versuchen.");
    } finally {
      setIsSaving(false);
    }
  }

  function acceptConsent() {
    localStorage.setItem("voice-consent", "yes");
    setConsentAccepted(true);
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

  async function handleRetryTranscription(recording: Recording) {
    setNotice("Transkript wird neu gestartet.");
    await retryRecordingProcessing(recording.id);
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

  async function handleLogout() {
    if (!firebase.auth) return;
    await signOut(firebase.auth);
    setSelectedId("");
  }

  function revealBatteryMode() {
    if (batteryRecording) {
      setAllowScreenSleep(false);
      setBatteryDimmed(false);
    }
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
      className={`app-shell ${batteryRecording ? "battery-mode" : ""} ${batteryDimmed ? "battery-dimmed" : ""}`}
      onClick={revealBatteryMode}
    >
      {!consentAccepted && (
        <section className="consent" role="dialog" aria-modal="true">
          <div className="consent-panel">
            <Mic size={30} aria-hidden="true" />
            <h1>Einwilligung zur Aufnahme</h1>
            <p>Bitte stellen Sie sicher, dass alle Gesprächsteilnehmer der Aufzeichnung zugestimmt haben.</p>
            <button className="primary-action" onClick={acceptConsent}>
              Verstanden
            </button>
          </div>
        </section>
      )}

      <header className="topbar">
        <div>
          <p className="eyebrow">Voice Recorder</p>
          <h1>{settingsOpen ? "Einstellungen" : mode === "recording" ? "Aufnahme erstellen" : "Aufzeichnungen"}</h1>
        </div>
        <div className="topbar-actions">
          <button className="user-pill" onClick={handleLogout}>
            <LogOut size={16} aria-hidden="true" />
            Abmelden
          </button>
        </div>
      </header>

      {settingsOpen && accessState?.isAdmin ? (
        <SettingsPanel
          settings={voiceSettings}
          onChange={setVoiceSettings}
          onClose={() => setSettingsOpen(false)}
          isAdmin={Boolean(accessState?.isAdmin)}
        />
      ) : null}

      {!settingsOpen && mode === "recording" ? (
        <section className="recording-view">
          <button className="ghost-action back-button" onClick={() => setMode("home")}>
            <Archive size={18} aria-hidden="true" />
            Aufzeichnungen
          </button>

          <div className="recorder-surface">
            <div className="recording-meter" aria-label={`Lautstärke ${recorder.volume} Prozent`}>
              <span style={{ height: `${Math.max(8, recorder.volume)}%` }} />
            </div>
            <p className="timer">{formatDuration(recorder.elapsedSeconds)}</p>
            <p className={`recorder-state recorder-state-${recorder.state}`}>
              {allowScreenSleep && recorder.state === "recording" ? <span className="recording-cursor" /> : null}
              {getRecorderStatusText(recorder.state, isSaving)}
            </p>

            <label className="screen-sleep-toggle">
              <input
                type="checkbox"
                checked={allowScreenSleep}
                onChange={(event) => setAllowScreenSleep(event.target.checked)}
                disabled={recorder.state === "recording" || recorder.state === "paused"}
              />
              Display darf waehrend der Aufnahme ausgehen
            </label>

            <div className="metadata-grid">
              <label>
                Name der Aufnahme
                <input
                  value={metadata.title}
                  onChange={(event) => setMetadata((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
            </div>

            {recorder.error && <p className="error-text">{recorder.error}</p>}

            <div className="recorder-actions">
              {recorder.state === "idle" || recorder.state === "error" ? (
                <button className="primary-action" onClick={() => recorder.start(!allowScreenSleep)}>
                  <Mic size={20} aria-hidden="true" />
                  Start
                </button>
              ) : null}
              {recorder.state === "recording" ? (
                <button className="secondary-action" onClick={recorder.pause}>
                  <Pause size={20} aria-hidden="true" />
                  Pause
                </button>
              ) : null}
              {recorder.state === "paused" ? (
                <button className="secondary-action" onClick={recorder.resume}>
                  <Play size={20} aria-hidden="true" />
                  Fortsetzen
                </button>
              ) : null}
              {recorder.state === "recording" || recorder.state === "paused" ? (
                <button className="danger-action" onClick={recorder.stop}>
                  <Square size={20} aria-hidden="true" />
                  Beenden
                </button>
              ) : null}
              {recorder.audioBlob ? (
                <button className="primary-action" onClick={() => saveBlob(recorder.audioBlob!)} disabled={isSaving}>
                  {isSaving ? <Loader2 className="spin" size={20} aria-hidden="true" /> : <Upload size={20} aria-hidden="true" />}
                  {isSaving ? "Upload läuft" : "Hochladen"}
                </button>
              ) : null}
              <button className="ghost-action" onClick={recorder.discard}>
                <Trash2 size={18} aria-hidden="true" />
                Verwerfen
              </button>
            </div>
          </div>
        </section>
      ) : !settingsOpen ? (
        <section className="workspace recordings-workspace">
          <aside className="list-panel">
            <div className="section-title">
              <Archive size={18} aria-hidden="true" />
              Aufzeichnungen
            </div>
            <div className="recording-list">
              {filtered.map((recording) => (
                <button
                  key={recording.id}
                  className={`recording-card compact-card ${selected?.id === recording.id ? "is-selected" : ""}`}
                  onClick={() => {
                    setSelectedId(recording.id);
                    setActiveTab("Audio");
                  }}
                >
                  <span className={`status-dot status-${recording.status}`} />
                  <strong>{recording.title}</strong>
                  <span>{formatDateTime(recording.createdAt)} · {formatDuration(recording.duration)}</span>
                </button>
              ))}
            </div>
          </aside>

          <section className="detail-panel clusters-panel">
            <div className="cluster-list">
              {filtered.map((recording) => (
                <RecordingCluster
                  key={recording.id}
                  recording={recording}
                  isOpen={openClusterId === recording.id}
                  onToggle={() => setOpenClusterId((current) => (current === recording.id ? "" : recording.id))}
                  onDelete={() => handleDelete(recording)}
                  onRename={(title) => handleRename(recording, title)}
                  onRetry={() => handleRetryTranscription(recording)}
                  onGenerateSpeech={(kind, targetLanguage) => handleGenerateSpeech(recording, kind, targetLanguage)}
                  onTranslate={(targetLanguage, source) => handleTranslate(recording, targetLanguage, source)}
                />
              ))}
            </div>
            {selected ? (
              <article className="recording-cluster">
                <div className="detail-header">
                  <div>
                    <p className="eyebrow">Aufnahme</p>
                    <h2>{selected.title}</h2>
                    <span>{formatDateTime(selected.createdAt)} · {formatDuration(selected.duration)}</span>
                  </div>
                  <button className="ghost-icon" aria-label="Gespräch löschen" onClick={() => handleDelete(selected)}>
                    <Trash2 size={20} aria-hidden="true" />
                  </button>
                </div>

                <section className="cluster-section">
                  <AudioTools recording={selected} audioRef={audioRef} />
                </section>
                <section className="cluster-section">
                  <SimpleTranscript
                    recording={selected}
                    onRetry={() => handleRetryTranscription(selected)}
                    onGenerateSpeech={() => handleGenerateSpeech(selected, "transcript")}
                    onTranslate={(targetLanguage) => handleTranslate(selected, targetLanguage, "transcript")}
                    onGenerateTranslationSpeech={(targetLanguage) =>
                      handleGenerateSpeech(selected, "transcriptTranslation", targetLanguage)
                    }
                  />
                </section>
                <section className="cluster-section">
                  <SimpleSummary recording={selected} onGenerateSpeech={() => handleGenerateSpeech(selected, "summary")} />
                </section>
                <section className="cluster-section">
                  <SimpleTranslation
                    recording={selected}
                    onTranslate={(targetLanguage) => handleTranslate(selected, targetLanguage)}
                    onGenerateSpeech={(targetLanguage) => handleGenerateSpeech(selected, "translation", targetLanguage)}
                  />
                </section>
                <section className="cluster-section">
                  <h3>Export</h3>
                  <SimpleExport recording={selected} />
                </section>
              </article>
            ) : (
              <div className="empty-state">
                <Mic size={40} aria-hidden="true" />
                <h2>Noch keine Gespräche</h2>
                <p>Starten Sie eine Aufnahme oder importieren Sie eine Audiodatei.</p>
              </div>
            )}
          </section>
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
          className={mode === "home" && !settingsOpen ? "is-active" : ""}
          onClick={() => {
            setSettingsOpen(false);
            setMode("home");
          }}
        >
          <Archive size={20} aria-hidden="true" />
          Aufzeichnungen
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
          <User size={26} aria-hidden="true" />
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
        <button className="primary-action wide-action" disabled={isBusy} onClick={() => submit("register")}>
          {isBusy ? <Loader2 className="spin" size={20} aria-hidden="true" /> : null}
          Konto erstellen
        </button>
        <button className="secondary-action wide-action" disabled={isBusy} onClick={() => submit("login")}>
          Einloggen
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
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-slider">
      <span>
        {label}
        <strong>{value.toFixed(2)}</strong>
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
  onRetry: () => void;
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
          <div className="cluster-actions">
            {isRenaming ? (
              <label className="rename-field">
                Name
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
              </label>
            ) : null}
            <button
              className="secondary-action"
              onClick={async () => {
                if (isRenaming) {
                  await onRename(draftTitle);
                }
                setIsRenaming((current) => !current);
              }}
            >
              {isRenaming ? "Speichern" : "Umbenennen"}
            </button>
            <button className="ghost-action" onClick={onDelete}>
              <Trash2 size={18} aria-hidden="true" />
              Löschen
            </button>
          </div>

          <section className="cluster-section">
            <AudioTools recording={recording} audioRef={clusterAudioRef} />
          </section>

          <section className="cluster-section">
            <SimpleTranscript
              recording={recording}
              onRetry={onRetry}
              onGenerateSpeech={() => onGenerateSpeech("transcript")}
              onTranslate={(targetLanguage) => onTranslate(targetLanguage, "transcript")}
              onGenerateTranslationSpeech={(targetLanguage) => onGenerateSpeech("transcriptTranslation", targetLanguage)}
            />
          </section>

          <section className="cluster-section">
            <SimpleSummary recording={recording} onGenerateSpeech={() => onGenerateSpeech("summary")} />
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

function Overview({ recording }: { recording: Recording }) {
  return (
    <div className="content-grid">
      <section>
        <h3>Kurzfassung</h3>
        <p>{recording.shortSummary || "Die KI-Auswertung steht noch aus."}</p>
      </section>
      <section>
        <h3>Zusammenfassung</h3>
        <p>{recording.summary || "Noch keine ausführliche Zusammenfassung vorhanden."}</p>
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
  onRetry,
  onGenerateSpeech,
  onTranslate,
  onGenerateTranslationSpeech
}: {
  recording: Recording;
  onRetry: () => void;
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
          <button className="secondary-action" onClick={onRetry}>
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
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Transkript</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {isOpen ? (
          <p className="muted">
            {recording.status === "transcribing" || recording.status === "analyzing"
              ? "Das Transkript wird erstellt."
              : "Noch kein Transkript vorhanden."}
          </p>
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
        <button className="secondary-action compact-action" onClick={onRetry}>
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
  onGenerateSpeech
}: {
  recording: Recording;
  onGenerateSpeech: () => Promise<string>;
}) {
  const summary = recording.shortSummary || recording.summary;
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="simple-summary">
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Hauptthema</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
      {summary ? (
          <ElevenLabsControls
            audioUrl={recording.elevenLabsSummaryAudioUrl}
            storageKey={`elevenlabs:${recording.id}:summary`}
            onGenerate={onGenerateSpeech}
          />
      ) : null}
      </div>
      {isOpen ? (
        summary ? (
          <p>{summary}</p>
        ) : (
          <p className="muted">
            {recording.status === "analyzing" || recording.status === "transcribing"
              ? "Die Zusammenfassung wird erstellt."
              : "Noch keine Zusammenfassung vorhanden."}
          </p>
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
        <button className="secondary-action compact-action" onClick={translate} disabled={isTranslating || !hasTranscript}>
          {isTranslating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
          Transkript uebersetzen
        </button>
      </div>
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Transkript uebersetzen</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {translation ? (
          <ElevenLabsControls
            audioUrl={translationAudioUrl}
            storageKey={`elevenlabs:${recording.id}:transcriptTranslation:${targetLanguage}`}
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
          <button className="secondary-action compact-action" onClick={translate} disabled={isTranslating || !hasTranscript}>
            {isTranslating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
            Transkript uebersetzen
          </button>
          {translation ? (
            <ElevenLabsControls
              audioUrl={translationAudioUrl}
              storageKey={`elevenlabs:${recording.id}:transcriptTranslation:${targetLanguage}`}
              onGenerate={() => onGenerateSpeech(targetLanguage)}
            />
          ) : null}
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
  const hasSummary = Boolean(recording.shortSummary || recording.summary);

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
        <button className="secondary-action compact-action" onClick={translate} disabled={isTranslating || !hasSummary}>
          {isTranslating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
          Zusammenfassung uebersetzen
        </button>
      </div>
      <div className="section-heading-row">
        <button className="section-toggle" onClick={() => setIsOpen((current) => !current)} aria-expanded={isOpen}>
          <h3>Uebersetzung</h3>
          <strong>{isOpen ? "Schließen" : "Öffnen"}</strong>
        </button>
        {translation ? (
          <ElevenLabsControls
            audioUrl={translationAudioUrl}
            storageKey={`elevenlabs:${recording.id}:summaryTranslation:${targetLanguage}`}
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
          <button className="secondary-action compact-action" onClick={translate} disabled={isTranslating || !hasSummary}>
            {isTranslating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : null}
            Zusammenfassung uebersetzen
          </button>
          {translation ? (
            <ElevenLabsControls
              audioUrl={translationAudioUrl}
              storageKey={`elevenlabs:${recording.id}:summaryTranslation:${targetLanguage}`}
              onGenerate={() => onGenerateSpeech(targetLanguage)}
            />
          ) : null}
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
  storageKey,
  onGenerate
}: {
  audioUrl?: string;
  storageKey: string;
  onGenerate: () => Promise<string>;
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [localAudioUrl, setLocalAudioUrl] = useState(() => audioUrl ?? localStorage.getItem(storageKey) ?? "");
  const [playbackHint, setPlaybackHint] = useState("");
  const elevenAudioRef = useRef<HTMLAudioElement>(null);
  const readyAudioUrl = localAudioUrl || audioUrl || "";

  useEffect(() => {
    if (audioUrl) {
      setLocalAudioUrl(audioUrl);
      localStorage.setItem(storageKey, audioUrl);
    }
  }, [audioUrl, storageKey]);

  async function generate() {
    setIsGenerating(true);
    setPlaybackHint("");
    try {
      const generatedUrl = await onGenerate();
      if (!generatedUrl) {
        throw new Error("Keine ElevenLabs-Audiodatei erhalten.");
      }
      setLocalAudioUrl(generatedUrl);
      localStorage.setItem(storageKey, generatedUrl);
      setPlaybackHint("Audio ist fertig. Jetzt Vorlesen antippen.");
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
          <RoundAudioToggle audioRef={elevenAudioRef} audioUrl={readyAudioUrl} label="Vorlesen" />
        </div>
      ) : null}
      {!readyAudioUrl ? (
        <button className="secondary-action" onClick={generate} disabled={isGenerating}>
          {isGenerating ? <Loader2 className="spin" size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}
          Audio erstellen
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
  label
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  audioUrl: string;
  label: string;
}) {
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const player = audioRef.current;
    if (!player) return undefined;
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
  }, [audioRef]);

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

function buildPlainTextProtocol(recording: Recording): string {
  return [
    recording.title,
    `Datum: ${formatDateTime(recording.createdAt)}`,
    `Teilnehmer: ${recording.participants.join(", ") || "Noch nicht erkannt"}`,
    "",
    "Zusammenfassung",
    recording.summary || recording.shortSummary,
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
