import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import OpenAI from "openai";
import { createHash } from "node:crypto";

initializeApp();

const db = getFirestore();
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const elevenLabsApiKey = defineSecret("ELEVENLABS_API_KEY");
const dropboxAppKey = defineSecret("DROPBOX_APP_KEY");
const dropboxAppSecret = defineSecret("DROPBOX_APP_SECRET");
const dropboxRefreshToken = defineSecret("DROPBOX_REFRESH_TOKEN");
const adminEmails = new Set(["kj_privat@yahoo.de"]);
const fallbackFemaleVoiceId = "EXAVITQu4vr4xnSDxMaL";

export const getAccessState = onCall(async (request) => {
  const email = normalizeEmail(request.auth?.token.email);
  if (!email) {
    throw new HttpsError("unauthenticated", "Login erforderlich.");
  }

  const isAdmin = adminEmails.has(email);
  const allowedSnapshot = await db.collection("allowedUsers").doc(email).get();
  const allowedByFieldSnapshot = allowedSnapshot.exists
    ? null
    : await db.collection("allowedUsers").where("email", "==", email).limit(1).get();
  return { allowed: isAdmin || allowedSnapshot.exists || Boolean(allowedByFieldSnapshot?.size), isAdmin, email };
});

export const getAllowedUsers = onCall(async (request) => {
  assertAdmin(request.auth?.token.email);
  const snapshot = await db.collection("allowedUsers").orderBy("email").get();
  return {
    emails: snapshot.docs.map((doc) => String(doc.data().email ?? doc.id)),
    users: snapshot.docs.map((doc) => ({
      name: String(doc.data().name ?? ""),
      email: String(doc.data().email ?? doc.id)
    }))
  };
});

export const saveAllowedUsers = onCall(async (request) => {
  const adminEmail = assertAdmin(request.auth?.token.email);
  const users = normalizeAllowedUsers(request.data?.users, request.data?.emails);
  const emails = users.map((user) => user.email);
  const batch = db.batch();
  const collection = db.collection("allowedUsers");
  const existing = await collection.get();
  existing.docs.forEach((doc) => {
    if (!emails.includes(doc.id)) batch.delete(doc.ref);
  });
  emails.forEach((email) => {
    const user = users.find((item) => item.email === email);
    batch.set(collection.doc(email), {
      email,
      name: user?.name ?? "",
      createdBy: adminEmail,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  await batch.commit();
  return { emails, users };
});

export const getAppSettings = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Login erforderlich.");
  }

  const snapshot = await db.collection("settings").doc("app").get();
  return normalizeAppSettings(snapshot.data());
});

export const saveAppSettings = onCall(async (request) => {
  const adminEmail = assertAdmin(request.auth?.token.email);
  const settings = normalizeAppSettings(request.data?.settings);
  await db.collection("settings").doc("app").set(
    {
      ...settings,
      updatedBy: adminEmail,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return settings;
});

export const getElevenLabsVoices = onCall({ secrets: [elevenLabsApiKey] }, async (request) => {
  assertAdmin(request.auth?.token.email);
  const apiKey = elevenLabsApiKey.value().trim();
  if (!apiKey) {
    throw new HttpsError("failed-precondition", "ELEVENLABS_API_KEY ist nicht gesetzt.");
  }

  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey }
  });
  if (!response.ok) {
    throw new HttpsError("internal", "ElevenLabs-Stimmen konnten nicht geladen werden.");
  }

  const data = (await response.json()) as { voices?: Array<Record<string, unknown>> };
  return {
    voices: (data.voices ?? []).map((voice) => ({
      id: String(voice.voice_id ?? ""),
      name: String(voice.name ?? "Unbenannte Stimme"),
      category: String(voice.category ?? "")
    })).filter((voice) => voice.id)
  };
});

export const processRecording = onCall({ secrets: [openaiApiKey] }, async (request) => {
  const uid = request.auth?.uid;
  const recordingId = request.data?.recordingId;
  const mode = request.data?.mode === "transcript" ? "transcript" : "summary";

  if (!uid) {
    throw new HttpsError("unauthenticated", "Login erforderlich.");
  }

  if (typeof recordingId !== "string" || !recordingId) {
    throw new HttpsError("invalid-argument", "recordingId fehlt.");
  }

  const recordingRef = db.collection("recordings").doc(recordingId);
  const recordingSnapshot = await recordingRef.get();
  const recording = recordingSnapshot.data();

  if (!recordingSnapshot.exists || recording?.userId !== uid) {
    throw new HttpsError("permission-denied", "Kein Zugriff auf diese Aufnahme.");
  }

  if (!recording.audioUrl) {
    throw new HttpsError("failed-precondition", "Audio-Link fehlt.");
  }

  try {
    let transcriptSegments = Array.isArray(recording.transcript) ? recording.transcript : [];
    let transcriptText = transcriptSegments.map((segment) => String(segment.text || "")).join(" ").trim();

    if (!transcriptText) {
      await recordingRef.update({ status: "transcribing" });
      const transcript = await transcribeFromUrl(recording.audioUrl);
      transcriptSegments = transcript.segments;
      transcriptText = transcript.text;
      await recordingRef.update({
        transcript: transcript.segments,
        language: transcript.language,
        status: mode === "transcript" ? "ready" : "analyzing",
        elevenLabsTranscriptAudioUrl: FieldValue.delete(),
        elevenLabsTranscriptAudioCacheKey: FieldValue.delete(),
        elevenLabsTranscriptTranslationAudioUrls: FieldValue.delete(),
        elevenLabsTranscriptTranslationAudioCacheKeys: FieldValue.delete()
      });
    }

    if (mode === "transcript") {
      return { ok: true };
    }

    if (!transcriptText) {
      throw new HttpsError("failed-precondition", "Transkript fehlt.");
    }

    await recordingRef.update({ status: "analyzing" });

    const appSettings = await getStoredAppSettings();
    const analysis = await analyzeTranscript(transcriptText, appSettings.summaryModel);
    await recordingRef.update({
      ...analysis,
      status: "done",
      elevenLabsSummaryAudioUrl: FieldValue.delete(),
      elevenLabsSummaryAudioCacheKey: FieldValue.delete(),
      elevenLabsTranslationAudioUrls: FieldValue.delete(),
      elevenLabsTranslationAudioCacheKeys: FieldValue.delete(),
      elevenLabsTranslationAudioUrl: FieldValue.delete()
    });

    return { ok: true };
  } catch (error) {
    console.error("processRecording failed", error);
    await recordingRef.update({
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Unbekannter Verarbeitungsfehler"
    });
    throw new HttpsError("internal", "Verarbeitung fehlgeschlagen.");
  }
});

export const generateSpeech = onCall({ secrets: [elevenLabsApiKey] }, async (request) => {
  const uid = request.auth?.uid;
  const recordingId = request.data?.recordingId;
  const kind = request.data?.kind;
  const targetLanguage = normalizeTargetLanguage(request.data?.targetLanguage);
  const voiceSettings = normalizeVoiceSettings(request.data?.voiceSettings, targetLanguage);

  if (!uid) {
    throw new HttpsError("unauthenticated", "Login erforderlich.");
  }

  if (typeof recordingId !== "string" || !recordingId) {
    throw new HttpsError("invalid-argument", "recordingId fehlt.");
  }

  if (kind !== "summary" && kind !== "transcript" && kind !== "translation" && kind !== "transcriptTranslation") {
    throw new HttpsError("invalid-argument", "kind muss summary, transcript oder translation sein.");
  }

  const recordingRef = db.collection("recordings").doc(recordingId);
  const recordingSnapshot = await recordingRef.get();
  const recording = recordingSnapshot.data();

  if (!recordingSnapshot.exists || recording?.userId !== uid) {
    throw new HttpsError("permission-denied", "Kein Zugriff auf diese Aufnahme.");
  }

  const text = getSpeechText(recording, kind, targetLanguage);
  if (!text) {
    throw new HttpsError("failed-precondition", "Kein Text zum Vorlesen vorhanden.");
  }

  try {
    const audioField = getElevenLabsAudioField(kind, targetLanguage);
    const cacheField = getElevenLabsCacheField(kind, targetLanguage);
    const cacheKey = createSpeechCacheKey(text, kind, targetLanguage, voiceSettings, recording);
    const cachedAudioUrl = getNestedRecordingValue(recording, audioField);
    const cachedKey = getNestedRecordingValue(recording, cacheField);
    if (cachedAudioUrl && cachedKey === cacheKey) {
      return { audioUrl: cachedAudioUrl };
    }

    const audioBuffer =
      kind === "transcript" && hasMultipleSpeakers(recording)
        ? await createDialogAudio(recording, voiceSettings)
        : await createElevenLabsAudio(text, voiceSettings);
    const token = crypto.randomUUID();
    const bucket = getStorage().bucket();
    const storagePath = `users/${uid}/recordings/${recordingId}/elevenlabs-${kind}${
      kind === "translation" || kind === "transcriptTranslation" ? `-${targetLanguage}` : ""
    }.mp3`;
    const file = bucket.file(storagePath);

    await file.save(audioBuffer, {
      contentType: "audio/mpeg",
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: token
        }
      }
    });

    const audioUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(
      storagePath
    )}?alt=media&token=${token}`;
    await recordingRef.update({
      [audioField]: audioUrl,
      [cacheField]: cacheKey
    });

    return { audioUrl };
  } catch (error) {
    console.error("generateSpeech failed", error);
    throw new HttpsError("internal", error instanceof Error ? error.message : "ElevenLabs fehlgeschlagen.");
  }
});

export const translateRecording = onCall({ secrets: [openaiApiKey] }, async (request) => {
  const uid = request.auth?.uid;
  const recordingId = request.data?.recordingId;
  const targetLanguage = normalizeTargetLanguage(request.data?.targetLanguage);
  const targetLanguageName = getTargetLanguageName(targetLanguage);
  const source = request.data?.source === "transcript" ? "transcript" : "summary";

  if (!uid) {
    throw new HttpsError("unauthenticated", "Login erforderlich.");
  }

  if (typeof recordingId !== "string" || !recordingId) {
    throw new HttpsError("invalid-argument", "recordingId fehlt.");
  }

  const recordingRef = db.collection("recordings").doc(recordingId);
  const recordingSnapshot = await recordingRef.get();
  const recording = recordingSnapshot.data();

  if (!recordingSnapshot.exists || recording?.userId !== uid) {
    throw new HttpsError("permission-denied", "Kein Zugriff auf diese Aufnahme.");
  }

  const sourceText =
    source === "transcript"
      ? getTranscriptTranslationSource(recording)
      : String(recording?.shortSummary || recording?.summary || "");
  if (!sourceText) {
    throw new HttpsError("failed-precondition", "Kein Text zum Übersetzen vorhanden.");
  }

  const completion = await getOpenAI().chat.completions.create({
    model: "gpt-4.1-mini",
    ...(source === "transcript" ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      {
        role: "system",
        content:
          source === "transcript"
            ? `Translate every transcript segment into natural ${targetLanguageName}. Return only JSON in this exact shape: {"segments":[{"id":"same id","text":"translated text"}]}. Preserve segment ids and do not include speaker labels or timestamps inside text. Do not add facts.`
            : `Translate the user's German summary into natural ${targetLanguageName}. Preserve meaning. Do not add facts.`
      },
      { role: "user", content: sourceText }
    ]
  });

  const rawTranslation = completion.choices[0]?.message.content?.trim();
  const transcriptSegments =
    source === "transcript" ? parseTranscriptTranslationSegments(rawTranslation, recording) : [];
  const translation =
    source === "transcript"
      ? transcriptSegments.map((segment) => stripSpeakerLabels(segment.text)).join(" ").trim()
      : rawTranslation;
  if (!translation) {
    throw new HttpsError("internal", "Übersetzung ohne Ergebnis.");
  }

  await recordingRef.update(
    source === "transcript"
      ? {
          [`transcriptTranslations.${targetLanguage}`]: translation,
          [`transcriptTranslationSegments.${targetLanguage}`]: transcriptSegments,
          [`elevenLabsTranscriptTranslationAudioUrls.${targetLanguage}`]: FieldValue.delete(),
          [`elevenLabsTranscriptTranslationAudioCacheKeys.${targetLanguage}`]: FieldValue.delete()
        }
      : {
          [`translations.${targetLanguage}`]: translation,
          [`elevenLabsTranslationAudioUrls.${targetLanguage}`]: FieldValue.delete(),
          [`elevenLabsTranslationAudioCacheKeys.${targetLanguage}`]: FieldValue.delete(),
          ...(targetLanguage === "en" ? { elevenLabsTranslationAudioUrl: FieldValue.delete() } : {}),
          ...(targetLanguage === "en" ? { englishTranslation: translation } : {})
        }
  );
  return { translation, targetLanguage, source };
});

export const exportRecordingToDropbox = onCall(
  { secrets: [dropboxAppKey, dropboxAppSecret, dropboxRefreshToken] },
  async (request) => {
    const uid = request.auth?.uid;
    const recordingId = request.data?.recordingId;

    if (!uid) {
      throw new HttpsError("unauthenticated", "Login erforderlich.");
    }

    if (typeof recordingId !== "string" || !recordingId) {
      throw new HttpsError("invalid-argument", "recordingId fehlt.");
    }

    const recordingSnapshot = await db.collection("recordings").doc(recordingId).get();
    const recording = recordingSnapshot.data();

    if (!recordingSnapshot.exists || recording?.userId !== uid) {
      throw new HttpsError("permission-denied", "Kein Zugriff auf diese Aufnahme.");
    }

    const accessToken = await getDropboxAccessToken();
    const dropboxContext = await getDropboxContext(accessToken);
    const folderPath = `/Aufzeichnungen/${sanitizeDropboxName(String(recording.title || recordingId))}`;
    const uploaded: string[] = [];

    console.info("Dropbox export context", dropboxContext);
    await ensureDropboxFolder(accessToken, folderPath);

    const summary = getRecordingSummaryText(recording);
    const transcript = getTranscriptText(recording);
    const protocol = buildDropboxProtocol(recording);

    await uploadDropboxFile(accessToken, `${folderPath}/Protokoll.txt`, Buffer.from(protocol, "utf8"), dropboxContext);
    uploaded.push("Protokoll.txt");

    if (transcript) {
      await uploadDropboxFile(accessToken, `${folderPath}/Transkript.txt`, Buffer.from(transcript, "utf8"), dropboxContext);
      uploaded.push("Transkript.txt");
    }

    if (summary) {
      await uploadDropboxFile(accessToken, `${folderPath}/Hauptthema.txt`, Buffer.from(summary, "utf8"), dropboxContext);
      uploaded.push("Hauptthema.txt");
    }

    if (recording.audioUrl) {
      const audioResponse = await fetch(String(recording.audioUrl));
      if (audioResponse.ok) {
        const contentType = audioResponse.headers.get("content-type") || "";
        const extension = getDropboxAudioExtension(contentType);
        await uploadDropboxFile(
          accessToken,
          `${folderPath}/Aufzeichnung${extension}`,
          Buffer.from(await audioResponse.arrayBuffer()),
          dropboxContext
        );
        uploaded.push(`Aufzeichnung${extension}`);
      }
    }

    return { folderPath, uploaded };
  }
);

async function transcribeFromUrl(audioUrl: string) {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error("Audio konnte nicht geladen werden.");
  }

  const audioBlob = await response.blob();
  const contentType = audioBlob.type || response.headers.get("content-type") || "audio/webm";
  const file = new File([audioBlob], getAudioFileName(contentType), { type: contentType });
  const transcription = (await getOpenAI().audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe-diarize",
    response_format: "diarized_json",
    chunking_strategy: "auto"
  } as unknown as Parameters<ReturnType<typeof getOpenAI>["audio"]["transcriptions"]["create"]>[0])) as unknown as Record<
    string,
    unknown
  >;
  const diarizedSegments = extractDiarizedSegments(transcription);

  return {
    text: String(transcription.text ?? diarizedSegments.map((segment) => segment.text).join(" ")),
    language: "language" in transcription ? String(transcription.language ?? "") : "",
    segments: diarizedSegments
  };
}

function getElevenLabsAudioField(
  kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
  targetLanguage: string
): string {
  if (kind === "summary") return "elevenLabsSummaryAudioUrl";
  if (kind === "translation") return `elevenLabsTranslationAudioUrls.${targetLanguage}`;
  if (kind === "transcriptTranslation") return `elevenLabsTranscriptTranslationAudioUrls.${targetLanguage}`;
  return "elevenLabsTranscriptAudioUrl";
}

function getElevenLabsCacheField(
  kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
  targetLanguage: string
): string {
  if (kind === "summary") return "elevenLabsSummaryAudioCacheKey";
  if (kind === "translation") return `elevenLabsTranslationAudioCacheKeys.${targetLanguage}`;
  if (kind === "transcriptTranslation") return `elevenLabsTranscriptTranslationAudioCacheKeys.${targetLanguage}`;
  return "elevenLabsTranscriptAudioCacheKey";
}

function createSpeechCacheKey(
  text: string,
  kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
  targetLanguage: string,
  voiceSettings: ReturnType<typeof normalizeVoiceSettings>,
  recording: FirebaseFirestore.DocumentData | undefined
): string {
  const speakerSignature =
    kind === "transcript" && hasMultipleSpeakers(recording)
      ? getDialogSpeakerSignature(recording, voiceSettings)
      : "";
  return createHash("sha256")
    .update(
      JSON.stringify({
        text,
        kind,
        targetLanguage,
        voiceId: voiceSettings.voiceId,
        stability: voiceSettings.stability,
        similarityBoost: voiceSettings.similarityBoost,
        style: voiceSettings.style,
        speed: voiceSettings.speed,
        speakerSignature
      })
    )
    .digest("hex");
}

function getNestedRecordingValue(recording: FirebaseFirestore.DocumentData | undefined, path: string): string {
  if (!recording) return "";
  const value = path.split(".").reduce<unknown>((currentValue, key) => {
    if (!currentValue || typeof currentValue !== "object") return undefined;
    return (currentValue as Record<string, unknown>)[key];
  }, recording) as string || "";
  return typeof value === "string" ? value : "";
}

function getDialogSpeakerSignature(
  recording: FirebaseFirestore.DocumentData | undefined,
  voiceSettings: ReturnType<typeof normalizeVoiceSettings>
): string {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  const speakers = Array.from(
    new Set(transcript.map((segment) => String(segment.speaker ?? "Sprecher 1").trim()).filter(Boolean))
  );
  return JSON.stringify(
    speakers.map((speaker, index) => ({
      speaker,
      voiceId: getDialogVoiceId(speaker, index, voiceSettings)
    }))
  );
}

function getAudioFileName(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("mp4")) return "recording.mp4";
  if (type.includes("m4a")) return "recording.m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return "recording.mp3";
  if (type.includes("wav")) return "recording.wav";
  if (type.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

async function analyzeTranscript(transcript: string, model: string) {
  const completion = await getOpenAI().chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Du analysierst Gesprächstranskripte. Erfinde keine Informationen. Schreibe shortSummary und summary immer auf Deutsch, auch wenn das Transkript eine andere Sprache enthält. Wenn Daten fehlen, nutze leere Arrays oder leere Strings. Antworte ausschließlich als JSON."
      },
      {
        role: "user",
        content: JSON.stringify({
          transcript,
          languageInstruction: "shortSummary und summary muessen standardmaessig auf Deutsch sein.",
          schema: {
            shortSummary: "3-5 Saetze auf Deutsch",
            summary: "Ausfuehrliche, nach Themen strukturierte Zusammenfassung auf Deutsch",
            topics: ["Hauptthema"],
            decisions: ["Beschluss"],
            tasks: [
              {
                id: "task-1",
                description: "Beschreibung",
                owner: "Verantwortlicher oder leer",
                dueDate: "Termin oder leer",
                status: "open"
              }
            ],
            appointments: ["Datums- oder Zeitangabe"],
            questions: ["Offene Frage"],
            keywords: ["Schlagwort"]
          }
        })
      }
    ]
  });

  const content = completion.choices[0]?.message.content;
  if (!content) {
    throw new Error("KI-Auswertung ohne Inhalt.");
  }

  const parsed = JSON.parse(content) as Record<string, unknown>;
  return {
    ...parsed,
    shortSummary: normalizeTextValue(parsed.shortSummary),
    summary: normalizeTextValue(parsed.summary)
  };
}

function normalizeTextValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => normalizeTextValue(item)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = record.text ?? record.content ?? record.summary ?? record.description;
    if (preferred !== undefined) return normalizeTextValue(preferred);
    return Object.values(record).map((item) => normalizeTextValue(item)).filter(Boolean).join("\n");
  }
  return "";
}

function getRecordingSummaryText(recording: Record<string, unknown>): string {
  return normalizeTextValue(recording.summary) || normalizeTextValue(recording.shortSummary);
}

function getOpenAI(): OpenAI {
  const apiKey = openaiApiKey.value().trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY ist nicht gesetzt.");
  }

  return new OpenAI({ apiKey });
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeAllowedUsers(usersValue: unknown, emailsValue: unknown) {
  const sourceUsers = Array.isArray(usersValue)
    ? usersValue
    : Array.isArray(emailsValue)
      ? emailsValue.map((email) => ({ email, name: "" }))
      : [];
  const users = sourceUsers
    .map((entry) => {
      const record: Record<string, unknown> =
        entry && typeof entry === "object" ? (entry as Record<string, unknown>) : { email: entry };
      return {
        name: typeof record.name === "string" ? record.name.trim() : "",
        email: normalizeEmail(record.email)
      };
    })
    .filter((user) => user.email);
  const seen = new Set<string>();
  return users.filter((user) => {
    if (seen.has(user.email)) return false;
    seen.add(user.email);
    return true;
  });
}

function normalizeAppSettings(value: unknown) {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    voiceId: typeof input.voiceId === "string" && input.voiceId.trim() ? input.voiceId.trim() : "JBFqnCBsd6RMkjVDRZzb",
    voicePreset: typeof input.voicePreset === "string" ? input.voicePreset : "male",
    stability: clampNumber(input.stability, 0, 1, 0.5),
    similarityBoost: clampNumber(input.similarityBoost, 0, 1, 0.75),
    style: clampNumber(input.style, 0, 1, 0),
    speed: clampNumber(input.speed, 0.7, 1.2, 1),
    summaryModel: normalizeSummaryModel(input.summaryModel),
    languageVoices: normalizeLanguageVoices(input.languageVoices)
  };
}

async function getStoredAppSettings() {
  const snapshot = await db.collection("settings").doc("app").get();
  return normalizeAppSettings(snapshot.data());
}

function normalizeSummaryModel(value: unknown): string {
  const model = typeof value === "string" ? value : "";
  return ["gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"].includes(model) ? model : "gpt-4.1-mini";
}

function normalizeLanguageVoices(value: unknown): Record<string, string> {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Object.entries(input).reduce<Record<string, string>>((voices, [language, voiceId]) => {
    if (typeof voiceId === "string" && voiceId.trim()) {
      voices[language.trim().toLowerCase()] = voiceId.trim();
    }
    return voices;
  }, {});
}

function assertAdmin(emailValue: unknown): string {
  const email = normalizeEmail(emailValue);
  if (!email || !adminEmails.has(email)) {
    throw new HttpsError("permission-denied", "Admin-Zugriff erforderlich.");
  }

  return email;
}

function extractDiarizedSegments(transcription: Record<string, unknown>) {
  const rawSegments = Array.isArray(transcription.segments) ? transcription.segments : [];

  if (!rawSegments.length) {
    return [
      {
        id: "segment-1",
        start: 0,
        end: 0,
        speaker: "Sprecher 1",
        text: String(transcription.text ?? "")
      }
    ];
  }

  return rawSegments.map((entry, index) => {
    const segment = entry as Record<string, unknown>;
    const speaker = String(segment.speaker ?? "A");

    return {
      id: String(segment.id ?? `segment-${index + 1}`),
      start: Number(segment.start ?? 0),
      end: Number(segment.end ?? 0),
      speaker: speaker.startsWith("Sprecher") ? speaker : `Sprecher ${speaker}`,
      text: String(segment.text ?? "")
    };
  });
}

function normalizeTargetLanguage(value: unknown): string {
  const code = typeof value === "string" ? value : "en";
  return getTargetLanguageName(code) ? code : "en";
}

function getTargetLanguageName(code: string): string {
  const languages: Record<string, string> = {
    en: "English",
    fr: "French",
    es: "Spanish",
    it: "Italian",
    nl: "Dutch",
    pl: "Polish",
    pt: "Portuguese",
    sv: "Swedish",
    da: "Danish",
    fi: "Finnish",
    no: "Norwegian",
    cs: "Czech",
    sk: "Slovak",
    sl: "Slovenian",
    hr: "Croatian",
    hu: "Hungarian",
    ro: "Romanian",
    bg: "Bulgarian",
    el: "Greek",
    et: "Estonian",
    lv: "Latvian",
    lt: "Lithuanian",
    ga: "Irish",
    mt: "Maltese",
    is: "Icelandic",
    uk: "Ukrainian",
    tr: "Turkish"
  };

  return languages[code] ?? "";
}

function getSpeechText(
  recording: FirebaseFirestore.DocumentData | undefined,
  kind: "summary" | "transcript" | "translation" | "transcriptTranslation",
  targetLanguage = "en"
): string {
  if (!recording) return "";

  if (kind === "summary") {
    return getRecordingSummaryText(recording).slice(0, 4500);
  }

  if (kind === "translation") {
    return String(recording.translations?.[targetLanguage] || recording.englishTranslation || "").slice(0, 4500);
  }

  if (kind === "transcriptTranslation") {
    return stripSpeakerLabels(String(recording.transcriptTranslations?.[targetLanguage] || "")).slice(0, 4500);
  }

  return getTranscriptText(recording).slice(0, 4500);
}

function getTranscriptText(recording: FirebaseFirestore.DocumentData | undefined): string {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  return transcript
    .map((segment) => {
      const text = String(segment.text ?? "");
      return stripSpeakerLabels(text);
    })
    .join("\n")
    .trim();
}

function hasMultipleSpeakers(recording: FirebaseFirestore.DocumentData | undefined): boolean {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  return new Set(transcript.map((segment) => String(segment.speaker ?? "").trim()).filter(Boolean)).size > 1;
}

async function createDialogAudio(
  recording: FirebaseFirestore.DocumentData | undefined,
  voiceSettings: ReturnType<typeof normalizeVoiceSettings>
): Promise<Buffer> {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  const speakers = Array.from(
    new Set(transcript.map((segment) => String(segment.speaker ?? "Sprecher 1").trim()).filter(Boolean))
  );
  const chunks: Buffer[] = [];

  for (const segment of transcript) {
    const text = stripSpeakerLabels(String(segment.text ?? ""));
    if (!text) continue;
    const speaker = String(segment.speaker ?? "Sprecher 1").trim();
    const voiceId = getDialogVoiceId(speaker, speakers.indexOf(speaker), voiceSettings);
    chunks.push(await createElevenLabsAudio(text, { ...voiceSettings, voiceId }));
  }

  if (!chunks.length) {
    throw new Error("Kein Transkripttext fuer Dialog-Audio vorhanden.");
  }

  return Buffer.concat(chunks);
}

function getDialogVoiceId(
  speaker: string,
  speakerIndex: number,
  voiceSettings: ReturnType<typeof normalizeVoiceSettings>
): string {
  const lowerSpeaker = speaker.toLowerCase();
  if (lowerSpeaker.includes("frau") || lowerSpeaker.includes("weib") || lowerSpeaker.includes("female")) {
    return fallbackFemaleVoiceId;
  }

  return speakerIndex % 2 === 1 ? fallbackFemaleVoiceId : voiceSettings.voiceId;
}

function getTranscriptTranslationSource(recording: FirebaseFirestore.DocumentData | undefined): string {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  return JSON.stringify({
    segments: transcript.map((segment) => ({
      id: String(segment.id ?? ""),
      text: String(segment.text ?? "")
    }))
  });
}

function parseTranscriptTranslationSegments(
  rawTranslation: string | undefined,
  recording: FirebaseFirestore.DocumentData | undefined
) {
  const transcript = Array.isArray(recording?.transcript) ? recording.transcript : [];
  try {
    const parsed = JSON.parse(rawTranslation || "{}") as { segments?: Array<{ id?: string; text?: string }> };
    const translated = Array.isArray(parsed.segments) ? parsed.segments : [];
    return transcript.map((segment, index) => {
      const sourceId = String(segment.id ?? `segment-${index + 1}`);
      const match = translated.find((entry) => entry.id === sourceId) ?? translated[index];
      return {
        id: sourceId,
        text: stripSpeakerLabels(String(match?.text ?? ""))
      };
    });
  } catch {
    return transcript.map((segment, index) => ({
      id: String(segment.id ?? `segment-${index + 1}`),
      text: ""
    }));
  }
}

function stripSpeakerLabels(text: string): string {
  return text
    .replace(/(?:^|\s)(?:speaker|sprecher)\s+[a-z0-9]+:\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeVoiceSettings(value: unknown, targetLanguage = "en") {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const languageVoices = normalizeLanguageVoices(input.languageVoices);
  const languageVoiceId = languageVoices[targetLanguage];
  const defaultVoiceId =
    typeof input.voiceId === "string" && input.voiceId.trim() ? input.voiceId.trim() : "JBFqnCBsd6RMkjVDRZzb";
  return {
    voiceId: languageVoiceId || defaultVoiceId,
    stability: clampNumber(input.stability, 0, 1, 0.5),
    similarityBoost: clampNumber(input.similarityBoost, 0, 1, 0.75),
    style: clampNumber(input.style, 0, 1, 0),
    speed: clampNumber(input.speed, 0.7, 1.2, 1)
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, numberValue));
}

async function createElevenLabsAudio(text: string, voiceSettings: ReturnType<typeof normalizeVoiceSettings>): Promise<Buffer> {
  const apiKey = elevenLabsApiKey.value().trim();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY ist nicht gesetzt.");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceSettings.voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: voiceSettings.stability,
          similarity_boost: voiceSettings.similarityBoost,
          style: voiceSettings.style,
          use_speaker_boost: true,
          speed: voiceSettings.speed
        }
      })
    }
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(getElevenLabsErrorMessage(message));
  }

  return Buffer.from(await response.arrayBuffer());
}

function getElevenLabsErrorMessage(message: string): string {
  if (message.includes("missing_permissions") || message.includes("text_to_speech")) {
    return "ElevenLabs-Key hat keine Text-to-Speech-Berechtigung. Bitte in ElevenLabs einen API-Key mit text_to_speech-Recht erstellen und als ELEVENLABS_API_KEY setzen.";
  }
  if (message.includes("invalid_api_key") || message.includes("unauthorized")) {
    return "ElevenLabs-Key ist ungueltig oder nicht autorisiert. Bitte den ELEVENLABS_API_KEY pruefen.";
  }
  return `ElevenLabs Fehler: ${message}`;
}

async function getDropboxAccessToken(): Promise<string> {
  const appKey = dropboxAppKey.value().trim();
  const appSecret = dropboxAppSecret.value().trim();
  const refreshToken = dropboxRefreshToken.value().trim();
  if (!appKey || !appSecret || !refreshToken) {
    throw new HttpsError("failed-precondition", "Dropbox ist noch nicht vollstaendig verbunden.");
  }

  const basic = Buffer.from(`${appKey}:${appSecret}`).toString("base64");
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    const message = await response.text();
    console.error("Dropbox token refresh failed", { status: response.status, message });
    throw new HttpsError(
      "internal",
      `Dropbox Access Token konnte nicht erneuert werden: ${formatDropboxError(message, response.status)}`
    );
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new HttpsError("internal", "Dropbox Access Token fehlt.");
  }
  return data.access_token;
}

type DropboxContext = {
  accountEmail?: string;
  accountName?: string;
  allocationType?: string;
  usedBytes?: number;
  allocatedBytes?: number;
  remainingBytes?: number;
};

async function getDropboxContext(accessToken: string): Promise<DropboxContext> {
  try {
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [accountResponse, spaceResponse] = await Promise.all([
      fetch("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers }),
      fetch("https://api.dropboxapi.com/2/users/get_space_usage", { method: "POST", headers })
    ]);

    const account = accountResponse.ok
      ? ((await accountResponse.json()) as { email?: string; name?: { display_name?: string } })
      : undefined;
    const space = spaceResponse.ok
      ? ((await spaceResponse.json()) as {
          used?: number;
          allocation?: { ".tag"?: string; allocated?: number };
        })
      : undefined;
    const allocatedBytes = typeof space?.allocation?.allocated === "number" ? space.allocation.allocated : undefined;
    const usedBytes = typeof space?.used === "number" ? space.used : undefined;

    return {
      accountEmail: account?.email,
      accountName: account?.name?.display_name,
      allocationType: space?.allocation?.[".tag"],
      usedBytes,
      allocatedBytes,
      remainingBytes:
        typeof allocatedBytes === "number" && typeof usedBytes === "number" ? allocatedBytes - usedBytes : undefined
    };
  } catch (error) {
    console.warn("Dropbox context lookup failed", error);
    return {};
  }
}

async function uploadDropboxFile(
  accessToken: string,
  path: string,
  contents: Buffer,
  context: DropboxContext
): Promise<void> {
  const response = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": toDropboxApiHeader({
        path,
        mode: "overwrite",
        autorename: false,
        mute: false
      })
    },
    body: contents
  });

  if (!response.ok) {
    const message = await response.text();
    console.error("Dropbox upload failed", { path, status: response.status, message, context });
    throw new HttpsError(
      "internal",
      `Dropbox Upload fehlgeschlagen: ${formatDropboxError(message, response.status, context)}`
    );
  }
}

async function ensureDropboxFolder(accessToken: string, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter(Boolean);
  let currentPath = "";
  for (const part of parts) {
    currentPath += `/${part}`;
    await createDropboxFolder(accessToken, currentPath);
  }
}

async function createDropboxFolder(accessToken: string, path: string): Promise<void> {
  const response = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      path,
      autorename: false
    })
  });

  if (response.ok) return;

  const message = await response.text();
  if (message.includes("path/conflict/folder") || message.includes("path/conflict")) return;

  console.error("Dropbox folder creation failed", { path, status: response.status, message });
  throw new HttpsError("internal", `Dropbox Ordner konnte nicht erstellt werden: ${formatDropboxError(message, response.status)}`);
}

function toDropboxApiHeader(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function formatDropboxError(message: string, status: number, context?: DropboxContext): string {
  if (message.includes("insufficient_space")) {
    const account = context?.accountEmail ? ` (${context.accountEmail})` : "";
    const remaining =
      typeof context?.remainingBytes === "number"
        ? ` Laut Dropbox-API sind ${formatBytes(context.remainingBytes)} frei.`
        : "";
    return `Dropbox meldet zu wenig Speicherplatz fuer das verbundene API-Konto${account}.${remaining} Falls dein Dropbox-Speicher nicht voll ist, bitte Dropbox neu verbinden.`;
  }

  if (!message.trim()) {
    return `Dropbox hat Status ${status} ohne Detailmeldung zurueckgegeben.`;
  }

  try {
    const parsed = JSON.parse(message) as { error_summary?: string; error?: unknown };
    if (parsed.error_summary) return parsed.error_summary;
    if (parsed.error) return JSON.stringify(parsed.error);
  } catch {
    return message;
  }

  return message;
}

function formatBytes(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (absolute >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (absolute >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} Byte`;
}

function sanitizeDropboxName(value: string): string {
  const clean = value.replace(/[\\/:*?"<>|#%{}~&]/g, " ").replace(/\s+/g, " ").trim();
  return clean.slice(0, 90) || "Aufzeichnung";
}

function getDropboxAudioExtension(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type.includes("mp4")) return ".mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return ".mp3";
  if (type.includes("wav")) return ".wav";
  if (type.includes("m4a")) return ".m4a";
  if (type.includes("ogg")) return ".ogg";
  return ".webm";
}

function buildDropboxProtocol(recording: FirebaseFirestore.DocumentData): string {
  return [
    String(recording.title || "Aufzeichnung"),
    "",
    "Hauptthema",
    getRecordingSummaryText(recording),
    "",
    "Transkript",
    getTranscriptText(recording),
    "",
    "Aufgaben",
    ...(Array.isArray(recording.tasks)
      ? recording.tasks.map((task) => {
          const item = task as Record<string, unknown>;
          return `- ${String(item.description || "")} ${String(item.owner || "")} ${String(item.dueDate || "")}`.trim();
        })
      : []),
    "",
    "Beschluesse",
    ...(Array.isArray(recording.decisions) ? recording.decisions.map((decision) => `- ${String(decision)}`) : [])
  ].join("\n");
}
