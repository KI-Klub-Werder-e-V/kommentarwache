# kommentarwache

**Kommentare moderieren, ohne jeden einzeln zu lesen.**

Deutsch · [English](README.en.md)

kommentarwache liest die Kommentare unter euren Posts und Videos, erledigt die klaren Fälle
selbst und zeigt Menschen nur das, worüber sich zwei KI-Modelle nicht einig werden. Die
Moderation bleibt Handarbeit, wo sie es sein muss, und wird Automatik, wo sie es sein kann.
Alles läuft auf einem eigenen kleinen Server, jede Entscheidung wird protokolliert, und
Coding-Agenten wie Claude Code, Codex oder opencode können dieselben Aufgaben übernehmen
wie ein Moderator im Dashboard.

Ein Projekt des [KI Klub Werder e. V.](https://github.com/KI-Klub-Werder-e-V), Apache-2.0.

## Wofür ist das gut?

Wer als Verein, Initiative oder kleine Redaktion Social-Media-Kanäle und Webseiten betreibt,
kennt es: Unter den meisten Kommentaren ist nichts zu tun, unter ein paar wenigen ist es
dringend, und dazwischen liegt eine große Grauzone aus Gereiztheit, Sarkasmus und
Streitereien. Alles von Hand zu lesen kostet Zeit und Nerven. Ein einfacher Filter für
„negative Kommentare“ hilft nicht, denn berechtigte Kritik ist nicht dasselbe wie
Beleidigung.

kommentarwache trennt das sauber:

- **Kritik bleibt stehen.** Ein harter Kommentar zu einem Produkt, einer Entscheidung oder
  einer Person des öffentlichen Lebens ist keine Regelverletzung. Beleidigungen,
  Drohungen, Hetze und Spam sind es.
- **Klare Fälle erledigen sich selbst.** Harmlose Kommentare werden durchgewunken, eindeutige
  Verstöße sofort ausgeblendet.
- **Unklare Fälle bekommen eine zweite Meinung** von einem lokal laufenden Sprachmodell, das
  Regeln, Beispiele und den Gesprächsverlauf kennt.
- **Menschen sehen nur den Rest.** Im Dashboard steht pro Fall, warum er hier gelandet ist,
  was beide Modelle gesagt haben und ein Link direkt zum Kommentar auf der Plattform. Wann
  ihr das erledigt, bestimmt ihr selbst.

## So läuft ein Kommentar durch

```
Kommentar (YouTube, Facebook, Instagram, eure Webseite …)
        │
        ▼
Stufe 1: schnelles Entscheidungsmodell (Jev, später Laya zum Selbsthosten)
        │
        ├── in Ordnung ─────────────► erledigt
        ├── klarer Verstoß ─────────► sofort ausblenden
        └── unklar
              │
              ▼
Stufe 2: Sprachmodell auf eurem Server (Ollama), mit Regeln und Beispielen
              │
              ├── in Ordnung / Verstoß bestätigt ──► erledigt
              └── weiter unklar oder Widerspruch ──► Prüfliste im Dashboard
```

Gelöscht oder gesperrt wird nur, wenn **beide** Stufen den Verstoß bestätigen. Ausblenden
lässt sich rückgängig machen, Löschen nicht, deshalb ist die Hürde dort höher.

## Was drinsteckt

- **Dashboard** für Moderator:innen mit eigenem Login: Prüfliste, Verlauf pro Kommentar
  (alle Modellantworten mit Wahrscheinlichkeiten, Entscheidungen, Aktionen), durchsuchbares
  Protokoll und Auswertungen.
- **Auswertungen**, die die Fragen beantworten, auf die es ankommt: Wie viele Kommentare
  wurden markiert? Wie viele davon bestätigt die zweite Stufe? Wie oft ändert sie das Urteil,
  und in welche Richtung? Wie oft widerspricht ein Mensch den Modellen? Welcher Anteil der
  Kommentare musste von Menschen gelesen werden?
- **Lückenloses Protokoll.** Jede Modellantwort, jede Entscheidung und jede Aktion wird
  gespeichert, das Protokoll ist manipulationssicher verkettet (`kw audit verify`).
- **Abgestufte Selbstständigkeit pro Quelle:** _aus_, _Probelauf_ (nur aufzeichnen, was
  passiert wäre), _vorschlagen_ oder _automatisch_, jeweils für Ausblenden, Löschen und
  Sperren, dazu eine Obergrenze pro Stunde. Neue Quellen starten mit allem auf _aus_.
- **Regeln im Code, nicht im Modell.** Schwellenwerte stehen in einer versionierten
  Richtlinie. Weil alle Wahrscheinlichkeiten gespeichert sind, lässt sich eine geänderte
  Richtlinie auf die Vergangenheit anwenden, ohne ein Modell erneut zu fragen.
- **Agenten-tauglich.** Alles, was im Dashboard geht, geht auch per MCP und REST, mit
  Tokens mit begrenzten Rechten (Löschen und Sperren werden bei Agenten standardmäßig zu
  Vorschlägen). Fertige Skills und Plugin-Dateien für Claude Code, Cowork, Codex und
  opencode: [`docs/agents.md`](docs/agents.md).
- **Der Weg zum eigenen Modell.** Am Anfang entscheidet Jev (eine Cloud-API). Wer lieber
  alles selbst betreibt, kann später mit den gesammelten Entscheidungen das offene Modell
  Laya trainieren, es zuerst im Schatten mitlaufen lassen, prüfen und dann umschalten,
  inklusive Rückweg: [`training/README.md`](training/README.md).

## Für wen ist es gedacht?

- Vereine, Initiativen und kleine Organisationen mit einem oder mehreren Kanälen
- Redaktionen und Blogs mit eigener Kommentarfunktion
- alle, die ihre Moderation nachvollziehbar halten und selbst hosten wollen

Es braucht einen Linux-Server mit 16 GB RAM, Docker und keine Grafikkarte.

## Ehrlicher Stand

Das Projekt ist jung (Version 0.1, Oktober 2026). Was bisher belegt ist und was nicht:

**Getestet und gemessen**

- Die Kernpipeline mit beiden Stufen, das Dashboard, die Aktionen auf einer simulierten
  Plattform und die Agenten-Schnittstelle laufen Ende zu Ende; 130 automatische Tests.
- Auf 357 echten Kommentaren aus _einem_ englischsprachigen Facebook-Thread musste nur
  etwa jeder elfte Kommentar (9 %) von Menschen gelesen werden, im ersten Prototyp war es
  jeder dritte (32 %). Die zweite Stufe war dabei etwas nachsichtiger als ein
  unabhängiger menschlicher Prüfer. Das ist ein einzelner Datensatz, kein Beweis für
  deutsche Kommentare oder andere Communities, und genau deshalb gibt es den Probelauf.
- Kosten der Entscheidungsstufe: rund 2 Cent für diese 357 Kommentare.
- Die zweite Stufe braucht auf einer 16-Kern-Workstation etwa 20 Sekunden pro Kommentar,
  und nur die unklaren Fälle durchlaufen sie. Auf einem älteren Server wird es länger
  dauern; das ist noch nicht gemessen.

**Noch nicht erprobt**

- Die Anbindungen an YouTube, Facebook-Seiten und Instagram sind gegen aufgezeichnete
  API-Antworten getestet, aber noch nicht mit echten Konten. Empfehlung: erst Probelauf.
- Laya (das offene Modell) braucht Feintuning mit euren eigenen Daten, bevor es Jev
  ersetzen kann; dafür sind etwa 1.200 beurteilte Kommentare nötig.

**Datenschutz**

- Kommentartexte gehen in der Anfangskonfiguration an die Jev-API von TypeSafe. Namen und
  Kennungen der Autor:innen werden nie an ein Modell geschickt. Für den Einsatz mit
  Kommentaren Dritter ist eine datenschutzrechtliche Prüfung nötig (Auftragsverarbeitung,
  Aufbewahrung, Informationspflichten); die bietet das Projekt nicht ab. Mit Laya auf
  dem eigenen Server entfällt die Weitergabe.

**Grenzen**

- Nur Text, keine Bilder oder Videos.
- Kein Livechat in Echtzeit. Das System ist für Kommentare gedacht, nicht für Millisekunden.
- LinkedIn, TikTok, X und weitere Plattformen sind noch nicht angebunden. Welche
  Plattform was überhaupt zulässt (Ausblenden, Löschen, Sperren), steht in
  [`docs/connectors.md`](docs/connectors.md).
- Es ersetzt keine Hausregeln. Was erlaubt ist, entscheidet ihr, das Werkzeug setzt es um.

## Schnellstart

Voraussetzungen: Node 24, pnpm, Docker (für Postgres), ein [TypeSafe-API-Schlüssel](https://console.typesafe.ai/)
und optional [Ollama](https://ollama.com/) für die zweite Stufe.

```bash
cp .env.example .env            # DATABASE_URL und TYPESAFE_API_KEY eintragen
docker compose up -d db
pnpm install && pnpm build
KW="node packages/server/dist/cli/main.js"
$KW migrate
$KW setup                        # Jev als Stufe 1, Ollama als Stufe 2
$KW token create --name demo     # gibt einen API-Token einmalig aus
$KW moderator create --email du@example.org --name "Du" --password 'mindestens zehn Zeichen'
pnpm --filter @kommentarwache/server dev
# Dashboard: http://localhost:8080/app
```

Einen Kommentar testen:

```bash
curl -s localhost:8080/v1/moderate \
  -H "Authorization: Bearer kw_..." -H "Content-Type: application/json" \
  -d '{"source":"demo","id":"c1","text":"Hast du den Artikel überhaupt gelesen? Na komm."}'
```

Die Antwort enthält das Urteil (`ok`, `unsure`, `violation`), die Kategorie, die Gründe mit
ihren Schwellenwerten und den Stand (`closed` oder `s2_pending`). Die zweite Stufe braucht
ein gezogenes Modell, etwa `ollama pull gemma4:12b-it-qat`.

Plattformen anbinden, Schritt für Schritt: [`docs/connectors.md`](docs/connectors.md).

## Dokumentation

| Thema                                                  | Wo                                             |
| ------------------------------------------------------ | ---------------------------------------------- |
| Aufbau und Entscheidungen                              | [`docs/architecture.md`](docs/architecture.md) |
| YouTube, Facebook, Instagram, eigene Webseite anbinden | [`docs/connectors.md`](docs/connectors.md)     |
| Nutzung durch Coding-Agenten (MCP, Skills, Plugins)    | [`docs/agents.md`](docs/agents.md)             |
| Von Jev zum eigenen Modell                             | [`training/README.md`](training/README.md)     |
| Messergebnisse und Testdaten                           | [`eval/README.md`](eval/README.md)             |
| Bauplan mit Meilensteinen (englisch)                   | [`docs/plan.md`](docs/plan.md)                 |

## Mitmachen

Das Projekt ist Open Source und freut sich über Hilfe: weitere Plattform-Anbindungen
(Telegram, Discord, WordPress, Threads, GitHub und Bluesky sind als Nächstes geplant),
Erfahrungen aus dem Probelauf, Testdaten ohne personenbezogene Inhalte, bessere
Beispiele für die Regeln der zweiten Stufe und Übersetzungen. Fehler und Ideen gern als
Issue. Für die Entwicklung:

```bash
pnpm install
pnpm build                       # prüft auch die Typen
TEST_DATABASE_URL=postgres://... pnpm test   # ohne Angabe startet ein Docker-Container
```

Arbeitsregeln für Menschen und Agenten stehen in [`AGENTS.md`](AGENTS.md). Echte
Kommentare gehören nie ins Repository.

## Lizenz

Apache-2.0, siehe [`LICENSE`](LICENSE).
