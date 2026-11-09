# Mitmachen bei kommentarwache

Schön, dass ihr mithelfen wollt! Gesucht sind vor allem weitere Plattform-Anbindungen, Erfahrungen aus dem Probelauf, Testdaten ohne personenbezogene Inhalte, bessere Beispiele für die Regeln der zweiten Stufe und Übersetzungen.

Sicherheitslücken bitte **nicht** als Issue melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben. Für alle Beiträge gilt unser [Verhaltenskodex](CODE_OF_CONDUCT.md).

## Einrichtung

Voraussetzungen: Node 24, pnpm, Docker.

```bash
pnpm install
pnpm build                       # prüft auch die Typen
TEST_DATABASE_URL=postgres://... pnpm test   # ohne Angabe startet ein Docker-Container
pnpm format                      # Prettier
```

## Regeln im Code

Die verbindlichen Arbeitsregeln für Menschen und Agenten stehen in [AGENTS.md](AGENTS.md). Die wichtigsten:

- Modelle klassifizieren, Code entscheidet. Schwellenwerte stehen in einer versionierten Richtlinie.
- Namen und Kennungen von Autor:innen gehen nie an einen Modellanbieter.
- Echte Kommentare gehören nie ins Repository, auch nicht in Issues oder Logs.

## Pull Requests

Haltet PRs klein und auf ein Thema beschränkt. Vor dem Öffnen muss `pnpm check` grün sein.

## Lizenz

kommentarwache steht unter der [Apache-2.0](LICENSE). Mit eurem Beitrag stimmt ihr zu, dass er unter dieser Lizenz veröffentlicht wird.
