import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from "firebase/storage";
import { firebase } from "./firebase";
import { sampleRecordings } from "./sampleData";
import type { DraftMetadata, Recording } from "../types";

const collectionName = "recordings";
const localKey = "voice-recorder-ai-demo-recordings";

export function subscribeToRecordings(
  userId: string,
  onChange: (recordings: Recording[]) => void,
  onError: (error: Error) => void
) {
  if (isLocalMode(userId)) {
    onChange(readLocalRecordings());
    return () => undefined;
  }

  const recordingsQuery = query(
    collection(firebase.db!, collectionName),
    where("userId", "==", userId),
    orderBy("createdAt", "desc")
  );

  return onSnapshot(
    recordingsQuery,
    (snapshot) => {
      const cloudRecordings = snapshot.docs.map((entry) => normalizeRecording(entry.id, entry.data()));
      const localRecordings = readLocalRecordings().filter((entry) => entry.userId === userId);
      onChange([...localRecordings, ...cloudRecordings]);
    },
    onError
  );
}

export async function createRecordingFromAudio(
  file: Blob,
  metadata: DraftMetadata,
  userId: string,
  duration: number
): Promise<Recording> {
  const now = new Date();
  const baseRecording: Omit<Recording, "id"> = {
    userId,
    title: metadata.title,
    category: metadata.category,
    project: metadata.project,
    participants: [],
    createdAt: now.toISOString(),
    duration,
    language: "",
    audioUrl: "",
    status: "uploading",
    shortSummary: "Audio wird hochgeladen.",
    summary: "",
    topics: [],
    decisions: [],
    tasks: [],
    appointments: [],
    questions: [],
    keywords: [],
    transcript: []
  };

  if (isLocalMode(userId)) {
    return createLocalRecording(file, {
      ...baseRecording,
      shortSummary: "Aufnahme gespeichert."
    });
  }

  try {
    const docRef = doc(collection(firebase.db!, collectionName));
    const audioRef = ref(firebase.storage!, `users/${userId}/recordings/${docRef.id}/${getAudioFileName(file)}`);
    const uploadTask = uploadBytesResumable(audioRef, file, { contentType: file.type || "audio/webm" });

    await new Promise<void>((resolve, reject) => {
      uploadTask.on("state_changed", undefined, reject, () => resolve());
    });

    const audioUrl = await getDownloadURL(audioRef);
    await setDoc(docRef, {
      ...baseRecording,
      audioUrl,
      status: "transcribing",
      shortSummary: "Audio wurde hochgeladen und wird verarbeitet.",
      createdAt: serverTimestamp()
    });
    await requestProcessing(docRef.id).catch(() => undefined);

    return {
      id: docRef.id,
      ...baseRecording,
      audioUrl,
      status: "transcribing"
    };
  } catch {
    return createLocalRecording(file, {
      ...baseRecording,
      shortSummary: "Aufnahme gespeichert."
    });
  }
}

export async function deleteRecording(recording: Recording): Promise<void> {
  if (isLocalMode(recording.userId)) {
    writeLocalRecordings(readLocalRecordings().filter((item) => item.id !== recording.id));
    return;
  }

  await deleteDoc(doc(firebase.db!, collectionName, recording.id));
  if (recording.audioUrl) {
    await deleteObject(ref(firebase.storage!, recording.audioUrl));
  }
}

export async function retryRecordingProcessing(recordingId: string): Promise<void> {
  if (!firebase.db || !firebase.functions) return;

  await updateDoc(doc(firebase.db, collectionName, recordingId), {
    status: "transcribing",
    errorMessage: ""
  });
  await requestProcessing(recordingId);
}

export async function renameRecording(recording: Recording, title: string): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  if (isLocalMode(recording.userId)) {
    const updated = readLocalRecordings().map((entry) =>
      entry.id === recording.id ? { ...entry, title: cleanTitle } : entry
    );
    writeLocalRecordings(updated);
    return;
  }

  await updateDoc(doc(firebase.db!, collectionName, recording.id), { title: cleanTitle });
}

export async function generateElevenLabsSpeech(
  recording: Recording,
  kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
  targetLanguage = "en",
  voiceSettings?: {
    voiceId: string;
    stability: number;
    similarityBoost: number;
    style: number;
    speed: number;
    voicePreset?: string;
    summaryModel?: string;
    languageVoices?: Record<string, string>;
  }
): Promise<string> {
  if (!firebase.functions) {
    throw new Error("ElevenLabs ist nur mit Firebase Functions verfügbar.");
  }

  const generateSpeech = httpsCallable<
    {
      recordingId: string;
      kind: "summary" | "transcript" | "translation" | "transcriptTranslation";
      targetLanguage: string;
      voiceSettings?: {
        voiceId: string;
        stability: number;
        similarityBoost: number;
        style: number;
        speed: number;
        voicePreset?: string;
        summaryModel?: string;
        languageVoices?: Record<string, string>;
      };
    },
    { audioUrl: string }
  >(firebase.functions, "generateSpeech");
  const result = await generateSpeech({ recordingId: recording.id, kind, targetLanguage, voiceSettings });
  return result.data.audioUrl;
}

export async function translateRecordingText(
  recording: Recording,
  targetLanguage: string,
  source: "summary" | "transcript"
): Promise<string> {
  if (!firebase.functions) {
    throw new Error("Übersetzung ist nur mit Firebase Functions verfügbar.");
  }

  const translateRecording = httpsCallable<
    { recordingId: string; targetLanguage: string; source: "summary" | "transcript" },
    { translation: string }
  >(
    firebase.functions,
    "translateRecording"
  );
  const result = await translateRecording({ recordingId: recording.id, targetLanguage, source });
  return result.data.translation;
}

export async function translateRecordingSummary(recording: Recording, targetLanguage: string): Promise<string> {
  return translateRecordingText(recording, targetLanguage, "summary");
}

export async function exportRecordingToDropbox(recording: Recording): Promise<{ folderPath: string; uploaded: string[] }> {
  if (!firebase.functions) {
    throw new Error("Dropbox-Export ist nur mit Firebase Functions verfuegbar.");
  }

  const exportCallable = httpsCallable<{ recordingId: string }, { folderPath: string; uploaded: string[] }>(
    firebase.functions,
    "exportRecordingToDropbox"
  );
  try {
    const result = await exportCallable({ recordingId: recording.id });
    return result.data;
  } catch (error) {
    throw new Error(getCallableErrorMessage(error, "Dropbox-Export fehlgeschlagen."));
  }
}

async function requestProcessing(recordingId: string): Promise<void> {
  if (!firebase.functions) return;
  const processRecording = httpsCallable(firebase.functions, "processRecording");
  await processRecording({ recordingId });
}

function getCallableErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "object" && error) {
    const candidate = error as { message?: unknown; details?: unknown; code?: unknown };
    if (typeof candidate.message === "string" && candidate.message.trim()) return candidate.message;
    if (typeof candidate.details === "string" && candidate.details.trim()) return candidate.details;
    if (typeof candidate.code === "string" && candidate.code.trim()) return `${fallback} (${candidate.code})`;
  }

  return fallback;
}

function readLocalRecordings(): Recording[] {
  const saved = localStorage.getItem(localKey);
  if (!saved) return sampleRecordings;

  try {
    return JSON.parse(saved) as Recording[];
  } catch {
    return sampleRecordings;
  }
}

function saveLocalRecording(recording: Recording): void {
  writeLocalRecordings([recording, ...readLocalRecordings()]);
}

function writeLocalRecordings(recordings: Recording[]): void {
  localStorage.setItem(localKey, JSON.stringify(recordings));
}

function isLocalMode(userId: string): boolean {
  return userId === "demo-user" || !firebase.db || !firebase.storage;
}

function createLocalRecording(file: Blob, recording: Omit<Recording, "id">): Recording {
  const localRecording: Recording = {
    id: crypto.randomUUID(),
    ...recording,
    audioUrl: URL.createObjectURL(file),
    status: "transcribing"
  };
  saveLocalRecording(localRecording);
  return localRecording;
}

function getAudioFileName(file: Blob): string {
  const type = file.type.toLowerCase();
  if (type.includes("mp4")) return "audio.mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "audio.mp3";
  if (type.includes("wav")) return "audio.wav";
  if (type.includes("m4a")) return "audio.m4a";
  return "audio.webm";
}

function normalizeRecording(id: string, data: DocumentData): Recording {
  const createdAt =
    typeof data.createdAt === "string"
      ? data.createdAt
      : data.createdAt?.toDate
        ? data.createdAt.toDate().toISOString()
        : new Date().toISOString();

  return {
    id,
    userId: String(data.userId ?? ""),
    title: String(data.title ?? "Unbenannte Aufnahme"),
    category: String(data.category ?? ""),
    project: String(data.project ?? ""),
    participants: Array.isArray(data.participants) ? data.participants : [],
    createdAt,
    duration: Number(data.duration ?? 0),
    language: String(data.language ?? ""),
    audioUrl: String(data.audioUrl ?? ""),
    status: data.status ?? "uploading",
    shortSummary: String(data.shortSummary ?? ""),
    summary: String(data.summary ?? ""),
    topics: Array.isArray(data.topics) ? data.topics : [],
    decisions: Array.isArray(data.decisions) ? data.decisions : [],
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    appointments: Array.isArray(data.appointments) ? data.appointments : [],
    questions: Array.isArray(data.questions) ? data.questions : [],
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    transcript: Array.isArray(data.transcript) ? data.transcript : [],
    translations: data.translations && typeof data.translations === "object" ? data.translations : undefined,
    transcriptTranslations:
      data.transcriptTranslations && typeof data.transcriptTranslations === "object"
        ? data.transcriptTranslations
        : undefined,
    transcriptTranslationSegments:
      data.transcriptTranslationSegments && typeof data.transcriptTranslationSegments === "object"
        ? data.transcriptTranslationSegments
        : undefined,
    elevenLabsTranslationAudioUrls:
      data.elevenLabsTranslationAudioUrls && typeof data.elevenLabsTranslationAudioUrls === "object"
        ? data.elevenLabsTranslationAudioUrls
        : undefined,
    elevenLabsTranscriptTranslationAudioUrls:
      data.elevenLabsTranscriptTranslationAudioUrls && typeof data.elevenLabsTranscriptTranslationAudioUrls === "object"
        ? data.elevenLabsTranscriptTranslationAudioUrls
        : undefined,
    englishTranslation: data.englishTranslation ? String(data.englishTranslation) : undefined,
    elevenLabsSummaryAudioUrl: data.elevenLabsSummaryAudioUrl ? String(data.elevenLabsSummaryAudioUrl) : undefined,
    elevenLabsTranscriptAudioUrl: data.elevenLabsTranscriptAudioUrl
      ? String(data.elevenLabsTranscriptAudioUrl)
      : undefined,
    elevenLabsTranslationAudioUrl: data.elevenLabsTranslationAudioUrl
      ? String(data.elevenLabsTranslationAudioUrl)
      : undefined,
    errorMessage: data.errorMessage ? String(data.errorMessage) : undefined
  };
}
