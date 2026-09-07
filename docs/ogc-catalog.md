# OGC-Suche und Wochen-Cache

Stand: 07.09.2026. Umsetzung von GEO-005 nach Nutzerfreigabe.

Quelle: [vollständige OGC-Collection-Metadaten](https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json).
Live am 07.09.2026: 894 Collections, etwa 1,30 MB JSON. Das sind
Layer-Metadaten; Geometrien und einzelne Features sind nicht im Katalog.

## Suche und bestehende Tools

`search_feature_collections` durchsucht ID, Titel und Beschreibung. Eingabe:
`query` mit 2–300 Zeichen, höchstens 20 unterschiedliche normalisierte Wörter;
`limit` standardmässig 8, maximal 20. Die Länge erlaubt auch vollständige IDs.
Alle Wörter müssen vorkommen, dürfen sich aber auf mehrere Felder verteilen.
Gross-/Kleinschreibung, Satzzeichen und deutsche Umlautumschriften werden
normalisiert. Es gibt keine fest eingebaute Layerliste, Synonyme oder Embeddings.

Eine exakt eingegebene ID steht zuerst, danach ein exakter Titel bzw. eine
normalisiert exakte ID. Weitere Treffer werden nach Feld und Phrasen-/Worttreffern
gewichtet; bei Gleichstand entscheidet die ID. `matchReasons` nennt Feld,
Trefferart und die normalisierten Wörter. Die ausgegebene ID bleibt unverändert.
Titel sind auf 300, Beschreibungen auf 600 Zeichen gekürzt. Treffergründe beziehen
sich auf die vollständigen Metadaten; Texttreffer beweisen keine fachliche Eignung.

`totalMatches`, `resultCount`, `searchedCollectionCount` und `truncated` machen
die Begrenzung sichtbar. Null Treffer ergeben eine erfolgreiche leere Liste.
Jeder Layer bleibt separat: das STAC-Produkt AVPZ hat beispielsweise 21 Layer;
eine Suche nach `avpz` mit Limit 20 meldet die ausgelassene Collection ausdrücklich.
Mit zusätzlichen Suchwörtern lässt sich gezielt eingrenzen. Die Suche ermittelt
keine formale STAC-Zuordnung; die bisherige Dataset-Code-Heuristik bleibt bestehen.

`get_dataset` und die Layer-Erkennung von `get_property_info(point)` verwenden
denselben Cache. Ihre Ergebnisse enthalten das Katalogalter unter
`ogcFeaturesDiscovery` bzw. `resolvedFrom`. STAC, einzelne Collection-Details,
Features und Grundstückinformationen werden weiterhin live abgefragt.
Der bekannte Grundstücks-Auswahlfehler GEO-001 ist eine separate offene Aufgabe.

Der MCP-Endpunkt bleibt `/mcp`; es kommt ein sechstes Tool hinzu. In bestehenden
Clients die Toolliste aktualisieren. Es gibt keinen öffentlichen Refresh-Endpunkt.

## Speicherung und Aktualisierung

Binding `OGC_CATALOG`, Namespace `geobs-mcp-ogc-catalog`, ein Schlüssel
`ogc-catalog:v1`. Ein vollständiger JSON-Snapshot enthält Schema-Version,
Abrufzeitpunkt, Quellen-URL, SHA-256-Inhaltshash, Anzahl und alle Collections
einschliesslich Ausdehnung, CRS und Links. Der Hash berücksichtigt stabile
Sortierung; ein unveränderter erfolgreicher Abruf erneuert trotzdem die Abrufzeit.

Die Nutzervorgabe lautet: Die Quelle wird höchstens dienstags aktualisiert.
Zwei UTC-Cron-Slots, Mittwoch 01:00 und 02:00, werden im Worker auf
**Mittwoch 03:00 Europe/Zurich** geprüft. Nur der passende Slot greift auf KV
und GeoBS zu. Damit bleibt 03:00 auch bei Sommer-/Winterzeit erhalten.
Cron wird von Cloudflare ausgeführt, unabhängig von MCP-Clients.

Vor dem Ersetzen: vorhandenen Snapshot prüfen, Quelle mit 25 Sekunden Timeout
und höchstens 12 MB lesen, eindeutige gültige IDs und 1–20.000 Collections prüfen.
Eine Folgeseite oder eine Anzahl unter 50 % bzw. über 200 % des bisherigen
Katalogs verhindert die automatische Ersetzung. Grössere legitime Änderungen
müssen manuell geprüft werden. Ein KV-Put ersetzt den kompletten Snapshot;
es gibt keinen Zwischenstand aus getrennten Metadaten- und Index-Schlüsseln.
KV ist eventual consistent: einzelne Standorte können nach dem Put noch kurz
den vorherigen gültigen Snapshot lesen.

Der Schlüssel hat keine Ablaufzeit. Ein Refresh-Fehler bewahrt den letzten guten
Stand und wird als Fehler geloggt. Es gibt keine zusätzliche automatische
Wiederholung; nach einem Fehler kann ein Administrator den unten beschriebenen
Refresh ausführen. Ansonsten folgt der nächste Versuch am nächsten Mittwoch.
Die Quelle wird nicht durch Nutzeranfragen erneut vollständig geladen.

Bis 7 Tage alt: frisch. Danach bis einschliesslich 14 Tage: nutzbar mit
`catalogStale=true`. Älter als 14 Tage: `UPSTREAM_UNAVAILABLE`, bis ein Refresh
erfolgreich ist. `catalogFetchedAt` und `catalogAgeSeconds` zeigen den Abrufstand,
nicht den unbekannten fachlichen Änderungszeitpunkt. Bei fehlendem oder ungültigem
Cache gibt es einen klaren Fehler; keine unkontrollierten GeoBS-Ersatzabrufe.
`get_dataset` kann wie bisher STAC-Daten mit einer Discovery-Warnung zurückgeben.
Direkte Feature-Abfragen mit bekannter ID bleiben unabhängig vom Gesamtkatalog.

## Erstbefüllung und administrativer Refresh

`npm run catalog:prepare` verwendet dieselbe Validierung und Schutzlogik wie der
Worker und schreibt nur öffentliche Metadaten nach `.wrangler/ogc-catalog.json`
(Git-ignoriert). Bei vorhandenem File ist dieses die Vergleichsbasis.

Erstinstallation in einem anderen Cloudflare-Account: einen eigenen Namespace
mit `wrangler kv namespace create OGC_CATALOG` anlegen und dessen ID in
`wrangler.jsonc` eintragen. Niemals die Namespace-ID eines fremden Accounts übernehmen.
Danach **vor dem Worker-Deployment** befüllen:

```bash
npm run catalog:prepare
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --remote
npm run deploy
```

Vor einem manuellen Refresh den tatsächlichen Remote-Snapshot als Vergleichsbasis
laden (PowerShell, UTF-8 ohne BOM):

```powershell
$catalogJson = npx wrangler kv key get ogc-catalog:v1 --binding OGC_CATALOG --remote --text
if ($LASTEXITCODE -ne 0) { throw 'KV read failed' }
[IO.Directory]::CreateDirectory((Join-Path $PWD '.wrangler')) | Out-Null
[IO.File]::WriteAllText((Join-Path $PWD '.wrangler/ogc-catalog.json'), ($catalogJson -join "`n"), [Text.UTF8Encoding]::new($false))
npm run catalog:prepare
if ($LASTEXITCODE -ne 0) { throw 'Catalog validation failed' }
npx wrangler kv key put ogc-catalog:v1 --binding OGC_CATALOG --path .wrangler/ogc-catalog.json --remote
```

Nicht blind weitermachen, wenn Validierung oder Upload fehlschlägt. Bei einer
legitimen grossen Bestandsänderung zuerst alte und neue Quelle prüfen; dann die
lokale Vergleichsdatei umbenennen, neu vorbereiten und bewusst ersetzen.
Einen defekten Remote-Snapshot genauso nach gesicherter Kopie ersetzen.
Es werden keine KV-Secrets oder zusätzlichen API-Schlüssel im Projekt benötigt;
Wrangler nutzt die bestehende Cloudflare-Anmeldung.

## Betrieb und Kosten

Ein zusätzlicher KV-Lesezugriff pro Katalognutzung, ungefähr ein Schreibzugriff
pro Woche und rund 1,3 MB persistente Metadaten. Nutzeranfragen nach bekannten
Feature-IDs benötigen keinen Katalogzugriff. Es wurde kein kostenpflichtiges
Abonnement oder neuer MCP-Endpunkt eingerichtet. Ob zusätzliche Kosten entstehen,
hängt vom bestehenden Cloudflare-Tarif und der gesamten Nutzung ab; der aktuelle
Account-Tarif wurde nicht zuverlässig festgestellt. Dieser kleine Katalog allein
liegt weit innerhalb der veröffentlichten kostenlosen Speicher-/Schreibkontingente.

Zusätzlich zu Tool- und HTTP-Ereignissen entstehen `catalog_cache` und
`catalog_refresh`. Felder und Collector-Anpassungen stehen in
[monitoring.md](monitoring.md). Ein manueller CLI-Upload erzeugt kein
Worker-Refresh-Ereignis; der nächste Cache-Zugriff zeigt dessen neuen Zeitpunkt.
Keine Suchbegriffe, Adressen oder Metadateninhalte in den eigenen Telemetrie-Logs.

Quellen: [KV lesen](https://developers.cloudflare.com/kv/api/read-key-value-pairs/),
[KV schreiben](https://developers.cloudflare.com/kv/api/write-key-value-pairs/),
[KV Limits](https://developers.cloudflare.com/kv/platform/limits/),
[KV Preise](https://developers.cloudflare.com/kv/platform/pricing/),
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
Technische Quellen während Analyse/Umsetzung am 07.09.2026 geprüft.

## Abnahme am 07.09.2026

- TypeScript und 84 Tests in 9 Dateien erfolgreich. Abgedeckt: alle sechs
  tatsächlichen MCP-Toolschemas einschliesslich portabler Array-Schemas,
  Text-/Structured-Ausgaben, Suche→Feature-Abfrage, Mehrfachlayer, Treffergründe,
  Eingabe-/Ausgabegrenzen, defekte/leere/zu alte Snapshots, Erhalt bei
  Refresh-Fehlern, Hashstabilität und Zeitumstellungen sowie Scheduled-Handler.
- Remote-KV gelesen und geprüft: 894 Collections, `fetchedAt`
  `2026-09-07T16:51:37.634Z`, SHA-256
  `cc3b581b9c8b5a0e2fb547170d9308b80380c065a3e5cda52b2cf8248c2c1a43`.
- Dry-run und Deployment erfolgreich, Version
  `4846f583-cf62-43aa-a6c6-b9558201039e`. Beide Cron-Slots durch die Cloudflare-API
  bestätigt. Der erste reguläre Lauf am 09.09.2026 wurde noch nicht beobachtet.
- Echter MCP-Client von 16:55:55 bis 16:55:58 UTC: sechs Tools, drei erfolgreiche
  Metadatensuchen (AVPZ, exakte ID, Strassennamen), anschliessend zwei Live-Features
  und `get_dataset(STNA)` mit demselben Cache-Zeitpunkt. AVPZ: 21 Treffer,
  20 ausgegeben, `truncated=true`. Suchlaufzeiten beim Client 291, 83 und 70 ms;
  Einzelmessungen einschliesslich Netzwerk, kein allgemeines Leistungsversprechen.
- Cloudflare-Logs bestätigen `catalog_cache` und erfolgreiche Toolausführungen
  der neuen Version. Beobachtete Such-Invocations: 37 bzw. 52 ms CPU, Outcome `ok`.
  Worker-Timer messen wegen ihrer Auflösung keine präzise CPU-Zeit;
  für diese KPI die Plattform-Invocation verwenden. Kein separater Suchindex nötig.
- Collector-/Grafana-Erweiterung gehört zur Aufgabe `infra-services-vm`;
  Worker-Abnahme allein bestätigt deren Umsetzung noch nicht.
