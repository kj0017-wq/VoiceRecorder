export type RecordingStatus =
  | "recording"
  | "uploading"
  | "transcribing"
  | "analyzing"
  | "done"
  | "error";

export type TaskStatus = "open" | "in_progress" | "done";

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface TranscriptTranslationSegment {
  id: string;
  text: string;
}

export interface RecordingTask {
  id: string;
  description: string;
  owner: string;
  dueDate: string;
  status: TaskStatus;
}

export interface Recording {
  id: string;
  userId: string;
  title: string;
  category: string;
  project: string;
  participants: string[];
  createdAt: string;
  duration: number;
  language: string;
  audioUrl: string;
  status: RecordingStatus;
  shortSummary: string;
  summary: string;
  topics: string[];
  decisions: string[];
  tasks: RecordingTask[];
  appointments: string[];
  questions: string[];
  keywords: string[];
  transcript: TranscriptSegment[];
  translations?: Record<string, string>;
  transcriptTranslations?: Record<string, string>;
  transcriptTranslationSegments?: Record<string, TranscriptTranslationSegment[]>;
  elevenLabsTranslationAudioUrls?: Record<string, string>;
  elevenLabsTranscriptTranslationAudioUrls?: Record<string, string>;
  englishTranslation?: string;
  elevenLabsTranslationAudioUrl?: string;
  elevenLabsSummaryAudioUrl?: string;
  elevenLabsTranscriptAudioUrl?: string;
  errorMessage?: string;
}

export interface DraftMetadata {
  title: string;
  category: string;
  project: string;
}
