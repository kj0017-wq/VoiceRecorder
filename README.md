# Gesprächsarchiv KI

Mobile-first React-App für Gesprächsaufzeichnung, Audioimport, Transkription, KI-Zusammenfassung, Suche, Archiv und Export.

## Enthalten

- React + TypeScript + Vite
- PWA-Konfiguration
- Firebase-ready Authentication, Firestore, Storage und Security Rules
- Cloud Function `processRecording` für serverseitige OpenAI-Verarbeitung
- Demo-Fallback ohne Firebase-Konfiguration
- Aufnahme mit Pause, Fortsetzen, Beenden, Verwerfen, Laufzeit, Lautstärke und Wake Lock
- Import für MP3, WAV, M4A, WEBM und MP4
- Ergebnis-Tabs für Übersicht, Aufgaben, Beschlüsse, Transkript und Audio
- Export als PDF-Druckansicht, Word-kompatibles Dokument, Text und Zwischenablage

## Lokaler Start

```bash
npm install
npm run dev
```

Unter Windows PowerShell kann `npm.ps1` durch die lokale Ausführungsrichtlinie blockiert sein. Dann `npm.cmd install` und `npm.cmd run dev` verwenden.

## Firebase

1. `.env.example` nach `.env` kopieren und Firebase-Web-Konfiguration eintragen.
2. Firebase Authentication mit E-Mail aktivieren.
3. Firestore, Storage und Functions im Firebase-Projekt aktivieren.
4. OpenAI-Key ausschließlich für Functions setzen, nicht im Frontend:

```bash
firebase functions:secrets:set OPENAI_API_KEY
```

Die WebApp nutzt ohne Firebase-Konfiguration automatisch lokale Demo-Daten.
