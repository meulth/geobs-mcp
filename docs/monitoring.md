# GeoBS MCP: Grafana-Datenvertrag

Stand: 7. September 2026. Repository `C:/src/geobs-mcp`, Worker `geobs-mcp`,
Produktionsadresse `https://geobs-mcp.thomas-meuli.workers.dev/mcp`.
Account-ID: `73fa5b88ac0a3107f84878c2f5d92c6d` (kein Geheimnis).

## Analyse und Aufbau

Vor dieser Änderung waren Workers Logs mit 100 % Sampling und Invocation-Logs
aktiv. Das liefert HTTP-Aufrufe, Plattformfehler und CPU-Zeiten, aber keine
verlässliche Zahl ausgeführter MCP-Tools: Initialisierung und `tools/list`
sind ebenfalls HTTP-Anfragen, und ein MCP-Toolfehler kann HTTP 200 haben.

Die Instrumentierung sitzt deshalb an drei bestehenden zentralen Stellen:
`index.ts` (HTTP), `mcp/register.ts` (Toolausführung samt Ergebnisgrößenlimit)
und `http.ts` (GeoBS-Zugriff einschließlich Body-Lesen und JSON-Parsing).
`telemetry.ts` hält die Korrelation über requestlokales AsyncLocalStorage.
Neue Tools und bestehende API-Clients erben die Messung automatisch.
Die Instrumentierung selbst benötigt keine zusätzlichen Laufzeitpakete,
Datenbanken oder Export-Requests. Für den OGC-Katalog ist seit GEO-005 das
KV-Binding `OGC_CATALOG` ergänzt. Ein Fehler des Log-Sinks verändert das MCP-Ergebnis nicht.

```text
MCP-Client -> Cloudflare Worker -> GeoBS API
                    |
                Workers Logs
                    ^
                    | ausgehender API-Abruf, etwa alle 5 Minuten
               VM220 Collector -> Loki (Loopback) -> Grafana
```

Die Codex-Aufgabe `infra-services-vm` hat Collector und Dashboard eingerichtet
und am 06.09.2026 erfolgreich abgenommen (Details unten).
Kein öffentlicher Loki-Endpunkt und kein Grafana-Cloud-Abo erforderlich.
Der Connector-Zugang in Codex ist kein automatisch verfügbarbarer VM-Zugang.
Ein eigener API-Token ist auf VM220 als systemd-Credential hinterlegt;
keine Schlüssel in Dashboard-JSON, Git, Logdateien oder Aufgaben-Nachrichten.

## Ereignisse, Version 1

`console.log` erhält genau ein strukturiertes Objekt. Gemeinsame Felder:
`service=geobs-mcp`, `schema_version=1`, `event_id` (zufällige UUID),
`request_id` (pro HTTP-Request zufällige UUID), `timestamp` (ISO UTC),
`event`, `duration_ms` (Zahl >= 0), `outcome=success|error`.
IDs werden vom Server erzeugt, nicht aus Client-Headern übernommen.

| event | Weitere Felder | Bedeutung |
| --- | --- | --- |
| `http_request` | `route=mcp|health|other`, `method`, `status` | Ein Ereignis, wenn der Handler eine Response liefert oder wirft. Dauer bis zur Response, nicht bis zum Ende eines SSE-Streams. Status >= 400 bzw. ungefangene Ausnahme (500) gilt hier als Fehler. |
| `mcp_tool` | `tool`, bei Erfolg `output_bytes`, bei Fehler `error_code` | Eine abgeschlossene Ausführung des registrierten Toolcallbacks. Dauer umfasst Ausführung und Aufbereitung des begrenzten MCP-Ergebnisses. Bytes sind die serialisierte MCP-Ergebnisgröße, keine Netzwerk-/SSE-Bytes. |
| `geobs_upstream` | `upstream`, optional `status`, `response_bytes`, `error_code` | Ein zugelassener GeoBS-Fetchversuch. Dauer umfasst Response-Body und JSON-Parsing. HTTP 200 mit ungültigem JSON oder Body-Timeout ist ein Fehler. Bytes nur vorhanden, wenn der Body vollständig gelesen wurde. |
| `catalog_cache` | bei Erfolg `catalog_age_seconds`, `catalog_stale`, `collection_count`; bei Fehler `error_code` | Ein KV-Katalogzugriff samt Parsing/Validierung; kein GeoBS-Fetch. |
| `catalog_refresh` | bei Erfolg `collection_count`, `snapshot_bytes`, `changed`; bei Fehler `error_code` | Ein abgeschlossener planmässiger Refresh. `changed` vergleicht den Inhaltshash; unveränderter Inhalt hat trotzdem eine neue Abrufzeit. |

Tool-Werteliste: `search_location`, `search_datasets`, `get_dataset`,
`query_features`, `get_property_info`, `search_feature_collections`.
Upstream-Werteliste: `search`, `stac`, `ogc_features`, `property_info`, `other`.
HTTP-Methoden: `GET`, `POST`, `DELETE`, `OPTIONS`, `HEAD`, `PUT`, `PATCH`, `OTHER`.
Fehlercodes siehe `src/errors.ts`; nur diese feste Werteliste übernehmen.
`NO_RESULTS`, `DATASET_NOT_FOUND` und `COLLECTION_NOT_FOUND` separat darstellen:
Sie sind MCP-Fehlerergebnisse, aber nicht automatisch eine Betriebsstörung.

Nicht enthalten: Argumente, Suchbegriffe, Adressen, Koordinaten, Grundstücks-IDs,
GeoBS-Ergebnisse, freie Fehlertexte, Header, IPs, Nutzernamen oder Roh-URLs.
Die weiterhin vorhandenen Cloudflare-Plattformlogs enthalten zusätzliche
Request-Metadaten. Diese nicht als komplettes Objekt nach Loki übernehmen.

## Erfassung abgrenzen

- Toolzählung meint abgeschlossene Callback-Ausführungen. Vom SDK vorher
  abgewiesene Schemas, unbekannte Tools und Protokollfehler zählen nicht als
  ausgeführte Tools. Die HTTP-Ebene erfasst die zugehörigen Requests separat.
- Erfolg ist das Ergebnis unserer Verarbeitung, keine Bestätigung der
  Auslieferung beim Client; SDK-Outputprüfung und Transport liegen danach.
- Worker-Hard-Limits/Abbrüche können Completion-Ereignisse verhindern.
  Plattform-Invocation-Outcomes ergänzen, nicht zu `http_request` addieren.
- Ein Tool kann mehrere GeoBS-Aufrufe auslösen. Diese Zahlen nicht addieren,
  um vermeintliche Nutzeraufrufe zu erhalten. Keine Unique-User-/Besucher-KPI.
- Toolhistorie beginnt erst mit diesem Deployment. Alte Invocation-Logs können
  nur HTTP-/Plattformhistorie liefern. Synthetische Prüfungen getrennt benennen.

## Verifizierter Abruf und Collector-Vertrag

Am 06.09.2026 lief dieser lesende Abruf über die Cloudflare-API erfolgreich:

`POST /accounts/{account_id}/workers/observability/telemetry/query`

```json
{
  "queryId": "geobs-grafana-export",
  "view": "events",
  "dry": true,
  "limit": 2000,
  "timeframe": { "from": 0, "to": 1 },
  "parameters": {
    "filters": [
      { "key": "$metadata.service", "operation": "eq", "type": "string", "value": "geobs-mcp" },
      { "key": "service", "operation": "eq", "type": "string", "value": "geobs-mcp" },
      { "key": "schema_version", "operation": "eq", "type": "number", "value": 1 }
    ]
  }
}
```

`from`/`to` durch Unix-Millisekunden des Abruffensters ersetzen. Die Antwort
enthält `result.events.events`. Nutzerfelder liegen in `event.source`,
Plattformfelder in `event.$workers` und `event.$metadata`.
Den Filter auf `source.service=geobs-mcp` und `source.schema_version=1` auch im
Collector zwingend anwenden. Die oben gezeigten API-Schlüsselnamen `service`
und `schema_version` sind unpräfixiert; beide wurden nach dem Deployment
anhand echter Felder und eines erfolgreichen gefilterten Abrufs verifiziert.

Pagination: Bei voller Seite die letzte `event.$metadata.id` als `offset`
und `offsetDirection="next"` senden, bei unverändertem Zeitfenster/Filter.
Live geprüft: die zweite Seite lieferte ein anderes, älteres Ereignis.
Bis zur leeren/verkürzten Seite paginieren; `events.count` war bei `limit=1`
ebenfalls 1 und darf nicht als Gesamtzahl interpretiert werden.
Cursor-Wiederholung und Seiten-/Zeit-/Byte-Limits als unvollständigen Abruf
erkennen; in diesem Fall keinen erfolgreichen Checkpoint vortäuschen.

Collector-Anforderungen:

1. Etwa 5-Minuten-Takt, kleiner Sicherheitsabstand zur Gegenwart, überlappende
   Abruffenster für verspätete Logs. Persistente Deduplizierung per `event_id`.
   Loki-Zeitstempel aus Ereigniszeit, deterministisch für Wiederholungen.
2. Checkpoint erst nach erfolgreicher Loki-Annahme aller Seiten fortschreiben.
   429/5xx und Timeouts begrenzt wiederholen; Ausfälle, verworfene Events,
   Sampling/Truncation und abgeschnittene Backfills explizit melden.
3. Nur bekannte Felder und Wertelisten übernehmen; numerische Werte auf
   Endlichkeit/nichtnegative Werte prüfen. Keine komplette `source`-Kopie.
   Nur zufällige Event-/Request-UUIDs im JSON, niemals als Loki-Labels.
4. Feste Labels: `job=geobs-mcp`, `environment=production`,
   `source=cloudflare-worker`, `event=http_request|mcp_tool|geobs_upstream|catalog_cache|catalog_refresh`.
   `tool`/`upstream`/`outcome` können zusätzlich begrenzte Labels sein.
   Collector-Zustand separat mit `source=cloudflare-exporter`.
5. Cloudflare-Abfrage-Sampling prüfen (`run.statistics.abr_level`, live 1),
   Worker-Sampling 1 und keine Truncation voraussetzen. Bei abweichenden
   Bedingungen keine exakten Gesamtzahlen behaupten. Leere Ergebnisse sind
   ohne funktionierenden Collector kein Nachweis für Null Traffic/Fehler.
6. Cloudflare dokumentiert 3 Tage Retention im Free-Plan, 7 im Paid-Plan.
   Ohne Planprüfung konservativ unter 3 Tagen nachholen; ältere Lücken anzeigen.
   Bestehende Loki-Retention (7 Tage) und Disk-Guard respektieren.

100-%-Sampling war bereits aktiv. Neu entstehen pro Request ein HTTP-Ereignis
und je ausgeführtem Tool/GeoBS-Fetch ein weiteres Ereignis. Das erhöht das
Logvolumen. Enthaltene Limits und eventuelle volumenabhängige Kosten sind
planabhängig; diese Änderung bucht kein neues Produkt/Abonnement.

## Dashboard-Vorschlag und LogQL

Ordner `Websites & APIs`, UID `geobs-mcp`, Titel `GeoBS MCP · Nutzung & Betrieb`.
Eigene Panels für Tool-Ausführungen, Tool-Verteilung, Aufrufe pro Minute,
MCP-Fehlerquote, Fehlercodes, mediane/p95-Toollaufzeit, HTTP-Statusklassen,
GeoBS-Aufrufe und -Fehler nach API, Upstream-p95, Ergebnisbytes und
Collector-Aktualität/Lücken. CPU-Zeit und Worker-Abbrüche optional aus explizit
gefilterten Plattform-Invocation-Events ergänzen.

Beispiele bei `event` als Label und restlichen Feldern im JSON:

```logql
sum(count_over_time({job="geobs-mcp",event="mcp_tool"}[$__range]))
sum by (tool) (count_over_time({job="geobs-mcp",event="mcp_tool"} | json | __error__="" [$__range]))
sum(rate({job="geobs-mcp",event="mcp_tool"}[5m])) * 60
100 * sum(count_over_time({job="geobs-mcp",event="mcp_tool"} | json | outcome="error" | __error__="" [$__range])) / sum(count_over_time({job="geobs-mcp",event="mcp_tool"}[$__range]))
quantile_over_time(0.95, {job="geobs-mcp",event="mcp_tool"} | json | unwrap duration_ms | __error__="" [5m]) by (tool)
sum by (error_code) (count_over_time({job="geobs-mcp",event="mcp_tool"} | json | outcome="error" | __error__="" [$__range]))
```

Abfragen auf der tatsächlich eingesetzten Loki-Version mit echten Daten
abnehmen. Fehlerquote ohne Aufrufe ist nicht definiert; `N/A` anzeigen.
Für erfolgreiche Abrufe ohne passende Fehlerereignisse darf die Fehleranzahl
kontrolliert auf 0 ergänzt werden. Den Zustand des Collectors daneben anzeigen.
Keine zusätzlichen Mailalarme beauftragt.

GEO-005 erweitert am 07.09.2026 die Tool-/Event-Wertelisten bei unveränderter
Schema-Version 1. `infra-services-vm` muss die Collector-Allowlist um das sechste
Tool, beide Ereignisse und die expliziten Zahlen-/Boolean-Felder ergänzen.
Bestehende Toolzählungen zählen Cache/Refresh nicht mit. `request_id` korreliert
beim Cron dessen Refresh und GeoBS-Fetch; es gibt dabei kein HTTP-Ereignis.
Der ungenutzte UTC-Cron-Slot erzeugt kein eigenes Anwendungsereignis.
Empfohlene Ergänzungen: Katalogalter/Veraltet-Markierung aus letzten Cache-Lesungen,
Refresh-Erfolg/-Fehler und Collection-Anzahl. Wegen sieben Tagen Loki-Retention
kann ein wöchentlicher Refresh aus dem Zeitfenster fallen; fehlende Ereignisse
sind kein Beweis für einen Fehler oder einen frischen Cache. Keine neuen Mailalarme.

## Quellen

- [Workers Logs: strukturierte Logs, Sampling, Limits und Preise](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Observability API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/)
- [Requestlokales AsyncLocalStorage](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/)
- [Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

Alle Quellen am 06.09.2026 geprüft. Installations- und Dashboard-Abnahme durch
`infra-services-vm` getrennt vom Worker-Deployment dokumentieren.

## Abnahme am 06.09.2026

- `npm run check`: TypeScript und alle 43 Tests in 8 Dateien erfolgreich.
  Neue Tests prüfen Request-Isolation, keine Inhalts-/Tokenweitergabe,
  echte MCP-Toolergebnisse, vorgelagerte Schemaablehnung, HTTP-200-JSON-Fehler,
  Body-Timeout und Fehlertoleranz bei defektem Log-Sink.
- `wrangler deploy --dry-run` und Produktionsdeploy erfolgreich. Aktive
  Version `dc0d3abb-9555-4ede-958e-b26d84d9d080`, 100 % seit 13:50:15 UTC.
- Live-MCP-Client 13:50:42–13:50:44 UTC: Health 200, alle fünf Tools gefunden,
  `search_location` erfolgreich, absichtlich unbekanntes Dataset liefert
  `DATASET_NOT_FOUND`. Die beiden Aufrufe gehören zum Smoke-Test.
- Gefilterter Cloudflare-Abruf danach: 11 eigene Ereignisse, davon 7 HTTP,
  2 Tool und 2 GeoBS. Alle richtige Version, keine Truncation, `abr_level=1`.
  Tool-Erfolg 297 ms/846 Ergebnisbytes, Toolfehler 287 ms. HTTP bei beiden
  Toolaufrufen 200 und 0 ms bis zur SSE-Response: Tool-Latenz muss deshalb aus
  `mcp_tool` stammen. Der SDK-Client probierte außerdem GET `/mcp` (405);
  erwartete Protokollaushandlung nicht als Serverstörung interpretieren.
- Logs wurden verzögert sichtbar (erster Abruf nur Teilmenge). Abrufüberlappung
  und Sicherheitsabstand sind deshalb praktisch erforderlich.
- Zum Zeitpunkt der Worker-Abnahme waren die Änderungen noch uncommitted
  und Collector sowie Dashboard noch nicht als installiert bestätigt.
  Die nachfolgende Infrastruktur-Abnahme ist unten getrennt dokumentiert.

## Bestätigter Grafana-Betrieb und Git-Abschluss

Quelle: Abschlussmeldung der Aufgabe `infra-services-vm` vom 06.09.2026,
in diese Dokumentation übernommen am 07.09.2026. Keine erneute VM-Abnahme
im Rahmen des Git-Abschlusses.

- [GeoBS-Dashboard](https://192.168.0.33:3443/d/geobs-mcp): 22 Panels und
  22 Abfragen mit echten Daten abgenommen. Die elf Smoke-Test-Ereignisse
  ergeben exakt zwei Tool-, sieben HTTP- und zwei Upstream-Ereignisse.
- Automatischer Fünf-Minuten-Timer aktiviert; erster API-Lauf um 14:11 UTC
  und periodischer Lauf um 14:15 UTC erfolgreich, ohne gemeldete Lücken.
- Eigener Cloudflare-Token, ausschließlich Account-Recht
  `Workers Observability:Edit`: Die API verlangt dieses Schreibrecht auch
  für die lesende `dry`-Abfrage. Geschützt als systemd-Credential auf VM220,
  keine Weitergabe der Wrangler-OAuth-/Refresh-Anmeldung.
- Keine zusätzlichen Mailalarme eingerichtet. Infrastrukturquellen liegen
  separat unter `C:/src/homelab/monitoring/geobs-poller/`.
- Am 07.09.2026 Typecheck und alle 43 Tests erneut erfolgreich. Die
  Cloudflare-Deployment-API bestätigt weiterhin Version
  `dc0d3abb-9555-4ede-958e-b26d84d9d080` zu 100 %. Der seit dieser Version
  unveränderte Laufzeitcode wird mit Tests und Dokumentation in Git gesichert;
  für die ergänzte Dokumentation ist kein neues Deployment erforderlich.
