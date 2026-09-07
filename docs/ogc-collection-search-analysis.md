# GEO-005: Direkte OGC-Suche und Metadaten-Cache

Analyse vom 07.09.2026, Arbeitsordner `C:/src/geobs-mcp`, Codebasis `c2e306e`.
Auftrag: analysieren und dokumentieren; keine Implementierung, kein Commit,
Push, Deployment oder Einrichten von Cloudflare-Ressourcen.
Die bereits lokal erweiterte `docs/ideas.md` wurde als Ausgangsstand respektiert.
GEO-005 war bei Beginn offen. Die folgende Analyse beschreibt den damaligen
Planungsstand. Danach gab der Nutzer die Umsetzung frei; sie ist am 07.09.2026
abgeschlossen. Aktueller Stand: [Umsetzung und Betrieb](ogc-catalog.md).

## Ergebnis und direkter Zugang

[OGC-Collection-Metadaten als JSON](https://api.geo.bs.ch/ogc/v1/wfs3/collections?f=json)

**Empfehlung:** Die direkte Suche ist eine sinnvolle Ergänzung der fünf
bestehenden Tools. Den Katalog zentral in Cloudflare KV speichern und regulär
einmal pro Woche durch einen Cron Trigger erneuern. Ergebnisse nennen den
Katalog-Abrufstand. Tatsächliche Features und Grundstücksinformationen bleiben
Live-Abfragen. Ein MCP-Server muss nicht bei jedem Toolaufruf sämtliche
Quellmetadaten neu laden: MCP regelt den Aufrufvertrag, nicht die interne
Cache-Strategie. Der Cache ist gemeinsamer Quelldatenbestand, kein Chatverlauf.

Nutzerangabe vom 07.09.2026: Die Quelldaten werden höchstens einmal pro Woche,
jeweils dienstags aktualisiert. Gewünschter Cache-Refresh: **Mittwoch 03:00 Uhr**,
als Schweizer Ortszeit (`Europe/Zurich`) verstanden. Damit liegt der reguläre
Abruf nach dem genannten Veröffentlichungstag. Diese Frequenz ist vom Nutzer
bestätigt, nicht durch eine eigene Zeitreihenmessung des Quellanbieters.

## Aktuelle Messung

Ein lesender HTTPS-GET vom lokalen Windows-Rechner, beendet um
**07.09.2026 16:27:26 UTC / 18:27:26 Europe/Zurich**. `Accept: application/json`,
`Accept-Encoding: gzip, br`. Kein API-Key für diesen Katalog verwendet.
Nur eine Stichprobe, kein Cloudflare-Benchmark oder Nachweis typischer Latenz.

| Messwert | Ergebnis |
| --- | --- |
| Status | HTTP 200 |
| Collections | 894 |
| Übertragener HTTP-Body | 1 296 983 Bytes, rund 1,30 MB / 1,24 MiB |
| Dekodierter JSON-Body | ebenfalls 1 296 983 Bytes |
| Dauer inklusive Download | 18 597 ms, rund 18,6 Sekunden |
| Content-Type | `application/json` |
| Content-Encoding | nicht vorhanden; in dieser Antwort keine Kompression |
| Content-Length | `1296983` |
| Cache-Control, ETag, Last-Modified, Expires | in dieser Antwort nicht vorhanden |
| ID, Titel, Beschreibung | bei allen 894 Einträgen nicht leer |
| Top-Level-Felder | `collections`, `crs`, `links`, `timeStamp` |

Nicht leere Beschreibungen sind nicht immer informativ: mindestens ein Eintrag
enthält lediglich „Keine Beschreibung vorhanden.“. Die Root-Links enthalten
`self` und `alternate`, keinen `next`-Link. Die Suche darf den Katalog erst nach
erfolgreicher Strukturprüfung als vollständig eingelesen behandeln.

Zusätzlich aus genau dieser Antwort **lokal berechnete** Grössen:

| Projektion | JSON-Bytes | Lokal mit gzip komprimiert |
| --- | ---: | ---: |
| Nur `id`, `title`, `description` | 311 751 | 38 692 |
| `id`, `title`, `description`, `crs`, `links` | 1 070 955 | 73 150 |

Die gzip-Zahlen sind ein Rechenvergleich, keine gemessene Serverkompression.
Die zweite Projektion lässt `extent` weg und ist deshalb kein unveränderter
Ersatz für alle bestehenden Verbraucher. Eine Suche braucht ungefähr 24 %
des aktuellen Rohumfangs als Textindex. Für Speicherung sind selbst 1,30 MB
überschaubar; problematischer sind wiederholtes Laden und die gemessene Wartezeit.

Der derzeitige Code erlaubt bis zu **12 000 000 Bytes** Katalogantwort und
25 Sekunden Metadaten-Timeout. Die 12 MB sind ein Schutzlimit, keine gemessene
Dateigrösse. Die Stichprobe blieb darunter und benötigte einen erheblichen Teil
des Timeout-Budgets. Das Antwort-`timeStamp` ist ohne weitere Prüfung kein
fachlicher Änderungszeitpunkt sämtlicher Layer.

## Bisheriger Code und unnötige Wiederholungen

| Stelle | Aktuelles Verhalten | Folgerung |
| --- | --- | --- |
| `src/clients/ogcFeatures.ts`, `listCollections()` | Holt und parst den gesamten Katalog bei jedem Aufruf | Zentraler Ansatzpunkt für gemeinsamen Katalogzugriff |
| `src/tools/getDataset.ts` | Lädt OGC-Katalog zur Zuordnung eines STAC-Produkts | Profitiert ebenfalls vom Cache |
| `src/tools/getPropertyInfo.ts` | Lädt Katalog bei Punkt-zu-Grundstück-Auflösung | Profitiert vom Cache; der offene Auswahlfehler GEO-001 bleibt eigenständig |
| `src/clients/ogcFeatures.ts`, `queryFeatures()` | Holt einzelne Collection und deren Features | Nicht mit dem gesamten Katalog verwechseln; zunächst live lassen |
| `src/tools/searchDatasets.ts` | Sucht nur STAC-Produkte, mit lokalem Ranking | Gute strukturelle Vorlage, aber keine direkte OGC-Layer-Suche |
| `src/mcp/server.ts` | Erzeugt Clients je Serverinstanz | Ein Instanzfeld wäre kein verlässlicher Cache über mehrere Requests |
| `wrangler.jsonc`, `src/index.ts` | Keine Speicherbindung, kein Scheduled-Handler | KV und Cron wären neue, noch nicht eingerichtete Infrastruktur |

Es gibt im Anwendungscode kein explizites Caching des OGC-Katalogs.
Vorgelagerte Caches des Quellanbieters sind damit nicht ausgeschlossen.
Mehrere `get_dataset`-Aufrufe in einer Unterhaltung können den grossen
Katalog mehrfach laden. Er wird bereits serverseitig ausgewertet und nicht
vollständig an das Sprachmodell übergeben. Caching spart vor allem
Upstream-Aufrufe, Download und wiederholte Quellverarbeitung, nicht automatisch
die entsprechende Menge Modellkontext.

## Vorgeschlagener Vertrag der direkten Suche

Arbeitstitel: `search_feature_collections`. Eigenes Tool nach dem vorhandenen
Muster aus Client, Toolmodul, `registerReadOnlyTool` und Registrierung im Server.
Kein neues LLM, keine Vektordatenbank, keine fest eingebaute Collection-Liste.

- Eingabe zunächst nur `query` (2–100 Zeichen) und `limit` (Standard 8,
  maximal 20). Query normalisieren; reine Satzzeichen bzw. danach leere
  Tokenliste zurückweisen. Keine beliebigen URLs oder freien Filtersprachen.
- Suche nur in ID, Titel und Beschreibung. Original-ID unverändert ausgeben.
  Gross-/Kleinschreibung und Akzente normalisieren; deutsche Schreibvarianten
  anhand gezielter Beispiele prüfen, statt eine neue Synonymliste zu erfinden.
- Nachvollziehbares Ranking: exakte ID vor exaktem Titel, dann zusammenhängende
  Treffer und einzelne Begriffe; ID/Titel stärker gewichten als Beschreibung.
  Als Startregel muss jeder Suchbegriff in mindestens einem dieser Felder
  vorkommen. Gleichstände nach Original-ID stabil sortieren.
- Pro Treffer `id`, `title`, gekürzter Beschreibungsauszug und begrenzte
  `matchReasons` aus Feld, Treffertyp und passenden Suchbegriffen ausgeben.
  Ein Score ist Rangordnung, keine Wahrscheinlichkeit fachlicher Eignung.
- Zusätzlich `searchedCollectionCount`, `totalMatches`, `resultCount`,
  `truncated` und `catalogFetchedAt`/`catalogAgeSeconds`/`catalogStale` ausgeben.
  Bei null Treffern ist ein leeres Ergebnis mit Katalogstand nützlicher als
  ein Fehler ohne Aktualitätsinformation; diesen Toolvertrag vor Umsetzung
  bewusst gegenüber der bestehenden STAC-Suche festlegen.
- Bestehende Ausgabegrenze 250 000 Bytes und Text-/StructuredContent-
  Kompatibilität beibehalten. Metadatentexte als Daten behandeln.
- Ergebnis-IDs direkt in `query_features` nutzbar machen. Server-Instruktionen
  um diesen kürzeren Weg ergänzen; bisherige STAC-Suche bleibt für Produkte,
  Downloads und weiterführende Metadaten zuständig.

### Mehrere Layer eines Produkts: bestätigter Fall

Im gemessenen Katalog gehören **21 Collection-IDs** zur Namensgruppe `AVPZ`.
Beispiele mit gemeinsamem Präfix
`ch.bs.av_parzellen_rechtliche_abgrenzungen_avpz`:

- `.liegenschaft`
- `.liegenschaftsgrenzpunkt`
- `.liegenschaft_laufende_aenderung`
- `.gemeindegrenze`
- `.text_symbol`

Diese Treffer nicht auf einen Produktnamen zusammenklappen. Eine Suche nach
`AVPZ` muss mehrere genaue IDs erhalten; bei Limit 20 auch den 21. Treffer als
abgeschnitten erkennen. Eine exakte ID muss vor ähnlich benannten Layern stehen.
Ein Treffer auf „Liegenschaft“ allein beweist keine Grundstücksgeometrie.
Die Produktzuordnung beruht weiter auf der dokumentierten Namenskonvention,
nicht auf einer formalen Beziehung im OGC-Schema.

## Welche Cloudflare-Variante passt?

| Variante | Vorteil | Grenze / Bewertung für dieses Projekt |
| --- | --- | --- |
| Jedes Mal live | Aktueller Quellabruf | Wiederholt grosse Antwort und Wartezeit; nicht empfohlen |
| Nur Worker-Arbeitsspeicher | Einfacher zusätzlicher Schnellzugriff | Isolates können verschwinden; keine gemeinsame wöchentliche Quelle |
| Nur Cache API | Wenig Implementierungsaufwand, TTL | Cache ist pro Rechenzentrum; kein globaler Einmal-pro-Woche-Abruf |
| KV + geplanter Refresh | Gemeinsamer persistenter Metadatenstand, seltene Writes | Eventuell verzögerte Sichtbarkeit neuer Versionen; hier gut tolerierbar |
| R2 | Geeignet für Rohdateien und spätere Versionen/Archive | Für diesen kleinen Katalog zunächst kein nötiger Zusatz |
| D1 / Durable Object | SQL bzw. stärkere Koordination | Für 894 per Text durchsuchbare Metadatensätze zunächst zusätzliche Komplexität |

Cloudflare beschreibt KV als geeignet für häufiges Lesen und seltenes Schreiben.
Ein Wert darf bis zu 25 MiB gross sein; der gemessene vollständige Katalog passt
deutlich hinein. Änderungen können in anderen Standorten erst nach 60 Sekunden
oder später sichtbar werden. Eine Wochenaktualisierung braucht keine
sofortige weltweite Konsistenz. [KV-Verhalten](https://developers.cloudflare.com/kv/concepts/how-kv-works/),
[KV-Limits](https://developers.cloudflare.com/kv/platform/limits/).

Die Cache API repliziert Einträge nicht zwischen Rechenzentren. Eine dort
gesetzte Wochen-TTL bedeutet deshalb nicht „GeoBS weltweit nur einmal pro
Woche laden“. [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## Empfohlener Start: KV-Snapshot und Wochen-Refresh

1. Vor Aktivierung den Katalog einmal kontrolliert abrufen und validieren.
   Ohne Startbestand soll nicht jeder öffentliche Suchaufruf einen neuen
   Vollabruf auslösen. Fehlender Cache wird als vorübergehend nicht verfügbar
   gemeldet; initiale Befüllung gehört zur Bereitstellung.
2. Zunächst ein vollständiges Katalog-Snapshot als ein KV-Wert mit eingebetteten
   Metadaten speichern: `schemaVersion`, `fetchedAt`, `source`,
   `contentHash`, `collectionCount`, `collections`. Vorhandene Felder wie
   `extent`, CRS und Links bleiben erhalten. Metadaten und Inhalt in einem
   Wert vermeiden Versionsmischung über mehrere Schlüssel.
3. `OgcFeaturesClient` erhält einen injizierbaren Katalogzugriff. Die Live-
   Abruffunktion für den Refresh bleibt vom Lesen des Snapshots getrennt.
   Dadurch verwenden neue Suche und bisherige Discovery denselben Katalog.
   Kein pauschaler Cache um `fetchJson`, der auch Features einfrieren würde.
4. Ein geplanter Lauf im selben Worker aktualisiert regulär **mittwochs um
   03:00 Uhr Europe/Zurich**. Cloudflare Cron verwendet UTC: im Schweizer Sommer
   entspricht das 01:00 UTC, im Winter 02:00 UTC. Die spätere Umsetzung muss
   die Zeitumstellung berücksichtigen, z. B. durch zwei mögliche UTC-Termine
   und eine Ortszeitprüfung, die nur am passenden Termin den Katalog abruft.
   `scheduled()` schreibt über KV-Bindings; das MCP bleibt für Nutzer read-only.
   [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
5. Neue Antwort vollständig innerhalb der Byte-/Zeitlimits lesen, Schema und
   eindeutige IDs prüfen. Leerer/ungültiger Katalog ersetzt nie einen gültigen.
   Auffällige Mengenänderungen als prüfbedürftig erkennen, ohne 894 als dauerhaft
   richtige Zahl fest einzubauen. Für den fachlichen Hash Collections stabil
   sortieren und flüchtige Abrufzeitstempel ausschliessen.
6. Erst nach erfolgreicher Prüfung den Wert ersetzen. Bei Fehler bleibt das
   letzte gültige Snapshot erhalten, mit seinem alten `fetchedAt`. Keine
   automatische Löschung nach genau sieben Tagen: Refresh-Ausfall soll keinen
   unnötigen Komplettausfall auslösen. Mehrere Standorte dürfen vorübergehend
   jeweils einen alten oder neuen, aber intern zusammengehörigen Stand lesen.
7. Vorschlag zur Aktualität: bis sieben Tage regulär; danach als veraltet
   markieren. Nach 14 Tagen ohne erfolgreichen Refresh die Suche klar als
   nicht hinreichend aktuell ablehnen. Diese Grenzen sind konfigurierbare
   Produktentscheidungen, noch keine bestätigte Nutzerpräferenz.
8. Bei Refresh-Fehlern begrenzte Wiederholungen bzw. einen administrativen
   Neuabruf vorsehen. Normalbetrieb einmal pro Woche, Fehlerbehandlung und
   manueller Refresh können zusätzliche Abrufe verursachen. Striktes
   Exactly-once-Verhalten wird mit KV allein nicht zugesichert und ist hier
   kein begründeter Grund für zusätzliche Koordinierungsinfrastruktur.
9. Cache-Lesealter, Refresh-Erfolg/-Fehler, Collection-Anzahl und Bytes erfassen.
   Der jetzige Telemetrie-Kontext beginnt im HTTP-Handler; ein Scheduled-Lauf
   braucht eigenen Kontext. Cache-Treffer dürfen nicht als GeoBS-Netzwerkaufruf
   gezählt werden. Eine spätere Grafana-Erweiterung wäre getrennt zu übergeben.

Ein kompakter, vorab normalisierter Suchindex ist eine mögliche zweite Stufe,
falls JSON-Parsing und Ranking im Worker relevant teuer sind. Dann rund 312 KB
Suchfelder statt des gesamten Katalogs lesen und die Version je Index mitführen.
Die Suche benötigt kein gzip-Dekomprimieren, solange ein kleines JSON-Snapshot
ausreicht. CPU-Zeit, KV-Kaltzugriff und JSON-Heap im Worker sind noch nicht
gemessen; die lokale 18,6-Sekunden-Zahl ist keine zugesagte Einsparung pro Tool.

Die fehlenden ETag-/Last-Modified-Header erlauben derzeit keine belegte
304-Revalidierungsoptimierung. Ein selbst gebildeter Hash erkennt gleiche
Inhalte erst nach dem Download. Die aktuelle `fetchJson`-Hilfsfunktion würde
HTTP 304 zudem als Nicht-Erfolg behandeln; falls GeoBS künftig Validatoren
liefert, wäre dafür ein bewusster Refresh-Pfad nötig.

## Umfang einer späteren Umsetzung und Abnahme

Betroffen wären voraussichtlich ein neues Such-Toolmodul, eine kleine
Katalogzugriffsschicht, `OgcFeaturesClient`, `mcp/server.ts`, der Scheduled-
Einstieg, Wrangler-Binding/Trigger und generierte Binding-Typen. Bestehende
Feature-Abfragen und Grundstücksinhalte bleiben live. Keine fachlichen
Auswahlheuristiken stillschweigend im Cache-Auftrag mitkorrigieren.

Gezielte Prüfungen vor einer späteren Bereitstellung:

- Reale `tools/list`-Schemas mit expliziten Array-`items`; Discovery und Aufruf
  im MCP-Client; Rückgabegrenzen und exakte IDs.
- Exakte ID, Titel, Beschreibung, Gross-/Kleinschreibung, Akzente, reine
  Satzzeichen, keine Treffer sowie deterministische Gleichstände.
- AVPZ mit mehreren Layern und abgeschnittener Ausgabe; kein Zusammenwerfen
  von Liegenschaft und Grenzpunkt. Dynamische Testdaten statt Produktionsliste.
- Cache-Lesen löst keinen Katalog-Upstream-Aufruf aus; alter gültiger Stand
  übersteht Timeout, defektes JSON und leere Refresh-Antwort.
- Fehlende Befüllung, Altersschwellen und neue Snapshot-Version; fachliche
  Katalogzeit nicht mit Abrufzeit verwechseln.
- `get_dataset` und Punkt-Auflösung behalten ihre bisher benötigten
  Metadatenfelder. Individuelle Collection-/Feature-Aufrufe bleiben live.
- Worker-Laufzeit/CPU und Speicherzugriff bei realer Kataloggrösse messen.

KV ist in Free und Paid mit Kontingenten enthalten; zusätzliche Operationen
bzw. überschrittene Limits sind planabhängig. Ein Katalog dieser Grösse und
wenige Writes sind klein, Reads hängen aber vom Traffic ab. Der konkrete
Account-Verbrauch wurde nicht geprüft, keine Kostenfreiheit zugesichert.
[KV-Preise und Kontingente](https://developers.cloudflare.com/kv/platform/pricing/).

Die Frequenz ist inzwischen durch die oben dokumentierte Nutzerangabe geklärt;
eine garantierte Uhrzeit des Dienstagsupdates ist weiterhin nicht angegeben.
Der Abruf der im Repository verlinkten GeoBS-AGB
über das Recherchewerkzeug war nicht erfolgreich; keine neue Aussage über
Nutzungsrechte daraus abgeleitet. Vor einer späteren produktiven Ablage die
geltenden Metadaten-Nutzungsbedingungen mit prüfen.

### Kosten- und Endpunktfrage des Nutzers

Für diesen Umfang sind innerhalb verfügbarer Kontingente **keine Zusatzkosten
zu erwarten**, aber keine unbedingte Nullkosten-Zusage: ca. 1,30 MB gespeicherter
Katalog, vier bis fünf reguläre Schreibvorgänge pro Monat und normalerweise ein
KV-Lesevorgang je katalogabhängigem Toolaufruf. Administrative Befüllung,
Wiederholungen und weitere Nutzer des Accounts verbrauchen ebenfalls Kontingent.

Laut Cloudflare enthält bereits der Free-Plan 1 GB KV-Speicher, 100 000 Reads
pro Tag und 1 000 Writes pro Tag. Bei Überschreitung schlagen Free-Operationen
fehl; Paid hat eigene Inklusivmengen und Mehrverbrauchspreise. Der geplante
Refresh nutzt den bestehenden Worker und dessen Ausführungs-/Logkontingente,
kein zusätzliches Abonnement allein für den Timer.
[KV-Kosten](https://developers.cloudflare.com/kv/platform/pricing/),
[Workers-Kosten](https://developers.cloudflare.com/workers/platform/pricing/).

Der Versuch, den Account-Tarif am 07.09.2026 lesend über die Subscription-API
zu prüfen, wurde mit einem Authentifizierungsfehler abgewiesen. Daher bleiben
Tarif und bereits verbrauchte Account-Kontingente ungeprüft. Es wurde nichts
gebucht oder an Abonnements geändert.

**Kein neuer öffentlicher MCP-Endpunkt nötig:** Die Verbindung bleibt unter
`https://geobs-mcp.thomas-meuli.workers.dev/mcp`. Das geplante Such-Tool wird
der bestehenden Toolliste hinzugefügt; KV und der geplante Lauf sind interne
Infrastruktur. Nach späterer Bereitstellung die Toolliste in den Clients
aktualisieren. Es gibt für den Wochen-Refresh keinen benötigten öffentlichen
Refresh-Endpunkt. Dieser Nachtrag ändert nur die Planung, nicht die Anwendung.

## Quellen und Standgrenzen

- Eigener begrenzter GET auf den oben verlinkten GeoBS-Katalog am 07.09.2026;
  Messwerte und AVPZ-Beispiele aus genau dieser Antwort.
- Lokaler Code in `src/clients/ogcFeatures.ts`, `src/tools/getDataset.ts`,
  `src/tools/getPropertyInfo.ts`, `src/tools/searchDatasets.ts`,
  `src/mcp/server.ts`, `src/http.ts`, `src/config.ts` und `wrangler.jsonc`.
- Cloudflare-Dokumente zu KV, Cache API und Cron, am 07.09.2026 abgerufen,
  direkt bei den jeweiligen Aussagen verlinkt.
- [MCP Tool-Vertrag](https://modelcontextprotocol.io/specification/2025-06-18/server/tools):
  Tool-Definitionen, Aufrufe und Ergebnisse; die vorgeschlagene interne
  Cache-Strategie ist unsere Architekturentscheidung.

Nur diese Analyse und der Dokumentationsverweis/Status in der Ideensammlung
wurden ergänzt. Anwendung, Cloudflare-Konfiguration und Infrastruktur unverändert.
