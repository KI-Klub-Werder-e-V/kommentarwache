# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versionierung: [SemVer](https://semver.org/).

## [0.1.0] - 2026-11-09

Erste öffentliche Version.

### Neu

- Zweistufige Pipeline: Entscheidungsmodell Jev als Stufe 1, lokales Sprachmodell über Ollama als Stufe 2, unklare Fälle in die Prüfliste.
- Dashboard für Moderator:innen mit eigenem Login, Verlauf pro Kommentar, Protokoll und Auswertungen.
- Manipulationssicher verkettetes Protokoll (`kw audit verify`).
- Aktionen Ausblenden, Löschen und Sperren mit Modi pro Quelle (aus, Probelauf, vorschlagen, automatisch), Obergrenze pro Stunde und Rückgängig.
- Anbindungen für YouTube, Facebook-Seiten, Instagram und eigene Webseiten. Getestet gegen aufgezeichnete API-Antworten, noch nicht mit echten Konten.
- MCP- und REST-Schnittstelle mit begrenzten Tokens, Skills und Plugin-Dateien für Claude Code, Codex und opencode.
- Llama Guard und OpenAI-Moderation als weitere Modelle in Stufe 1.
- Weg zum offenen Modell Laya: Schattenbetrieb, Trainingsexport, Prüfung, Umschalten und Rückweg.

[0.1.0]: https://github.com/KI-Klub-Werder-e-V/kommentarwache/releases/tag/v0.1.0
