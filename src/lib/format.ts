export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const rest = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function createFallbackTitle(date = new Date()): string {
  const datePart = new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
  const timePart = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

  return `Gespräch vom ${datePart} ${timePart}`;
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    recording: "Aufnahme",
    uploading: "Upload",
    transcribing: "Transkription",
    analyzing: "KI-Auswertung",
    done: "Fertig",
    error: "Fehler"
  };

  return labels[status] ?? status;
}
