import type { Recording } from "../types";

export const sampleRecordings: Recording[] = [
  {
    id: "sample-1",
    userId: "demo-user",
    title: "Projektabstimmung TankProfi",
    category: "Meeting",
    project: "TankProfi",
    participants: ["Klaus", "Ricarda", "Team Vertrieb"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    duration: 2380,
    language: "de",
    audioUrl: "",
    status: "done",
    shortSummary:
      "Das Team hat die nächsten Schritte für TankProfi priorisiert, offene Schnittstellen geklärt und Verantwortlichkeiten verteilt.",
    summary:
      "Im Gespräch wurden die verbleibenden Anforderungen für das Projekt TankProfi geordnet. Schwerpunkt war die Datenübergabe an das bestehende CRM, die Abstimmung mit Vertrieb und die Vorbereitung einer Kundenpräsentation. Die technische Klärung der API bleibt kritisch, während die Präsentation bereits vorbereitet werden kann.",
    topics: ["CRM-Schnittstelle", "Kundenpräsentation", "Rollout-Plan"],
    decisions: [
      "Die API-Klärung wird vor die finale Designfreigabe gezogen.",
      "Die Kundenpräsentation erhält eine eigene Demo-Sequenz."
    ],
    tasks: [
      {
        id: "task-1",
        description: "API-Fragen mit dem CRM-Team abstimmen",
        owner: "Ricarda",
        dueDate: "02.08.2026",
        status: "open"
      },
      {
        id: "task-2",
        description: "Demo-Ablauf für die Kundenpräsentation vorbereiten",
        owner: "Klaus",
        dueDate: "05.08.2026",
        status: "in_progress"
      }
    ],
    appointments: ["05.08.2026 Kundenpräsentation"],
    questions: ["Welche Felder liefert die CRM-API in Version 2?"],
    keywords: ["TankProfi", "CRM", "Demo", "Vertrieb"],
    transcript: [
      {
        id: "segment-1",
        start: 0,
        end: 18,
        speaker: "Sprecher 1",
        text: "Wir sollten heute die offenen Punkte für TankProfi sortieren."
      },
      {
        id: "segment-2",
        start: 19,
        end: 43,
        speaker: "Sprecher 2",
        text: "Wichtig ist aus meiner Sicht zuerst die CRM-Schnittstelle."
      },
      {
        id: "segment-3",
        start: 44,
        end: 78,
        speaker: "Sprecher 1",
        text: "Dann übernimmt Ricarda die Abstimmung und ich bereite die Demo vor."
      }
    ]
  },
  {
    id: "sample-2",
    userId: "demo-user",
    title: "Interview zur mobilen Nutzung",
    category: "Interview",
    project: "Gesprächsarchiv KI",
    participants: ["Klaus", "Testnutzer"],
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 27).toISOString(),
    duration: 1460,
    language: "de",
    audioUrl: "",
    status: "analyzing",
    shortSummary:
      "Die Aufnahme wurde transkribiert und wird aktuell strukturiert ausgewertet.",
    summary: "",
    topics: ["Mobile Bedienung", "Import", "Offline-Sicherheit"],
    decisions: [],
    tasks: [],
    appointments: [],
    questions: [],
    keywords: ["PWA", "Aufnahme", "Import"],
    transcript: []
  }
];
