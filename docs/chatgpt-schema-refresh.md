# ChatGPT-Refresh: Ursache und bestätigter Fix

07.09.2026. Der Nutzer meldete weiterhin `Invalid MCP tool schema for tool
'query_features'`, obwohl Claude die Toolliste aktualisieren konnte und direkte
MCP-Abfragen funktionierten. Der Fehler wurde durch Betätigen von `Aktualisieren`
in der angemeldeten ChatGPT-Oberfläche selbst reproduziert.

## Ursache eingrenzen

Der Live-Server auf Stand `fcf6197` lieferte sechs Tools inklusive
`search_feature_collections`. Die frühere Korrektur von `bbox` war dort vorhanden:
`items.type=number`, `minItems=maxItems=4`, kein `prefixItems`.
Ein direkter `query_features`-Aufruf war erfolgreich.

ChatGPT zeigte eine ältere gespeicherte Toolliste: `create_map_link`, keine
Collection-Suche, `bbox.prefixItems` ohne `items`. Das war ein nicht aktualisierter
Stand; allein daraus liess sich die Ursache des gescheiterten Refreshs nicht ableiten.

Im aktuellen Eingabeschema von `query_features` enthielten allein
`properties.items.pattern` und `filters.items.properties.property.pattern` diesen
Unicode-Regulärausdruck:

```text
^[\p{L}\p{N} _.-]{1,100}$
```

Der JavaScript-Code verwendete dafür den Unicode-Schalter `u`. Ein JSON-Schema-
`pattern` überträgt diesen Schalter nicht separat; die Unterstützung der
Unicode-Klassen hängt vom Validator ab. Als lokale Gegenprobe lehnt Pythons
Standardbibliothek `re` denselben Ausdruck mit `bad escape \p` ab. Das beweist
**nicht**, dass ChatGPT intern Python verwendet. Der interne Validator ist unbekannt.
Die JSON-Schema-Dokumentation empfiehlt für interoperable Patterns ausdrücklich
einen breit unterstützten Regex-Teilumfang.

## Gezielte Änderung und tatsächliche Abnahme

`propertyNameSchema` behält exakt denselben Unicode-Regulärausdruck als
serverseitiges Zod-Refinement. Im veröffentlichten Schema stehen stattdessen
`type=string`, `minLength=1`, `maxLength=100` und eine Beschreibung der Zeichenregel.
Das erhält auch die bisherige Behandlung von Umlauten, nichtlateinischen Buchstaben
und bis zu 100 Unicode-Codepunkten. Die Laufzeitvalidierung wird nicht abgeschaltet.

Die übrigen fünf veröffentlichten Tools sind im Vorher-/Nachher-Vergleich identisch.
Die Output-Schemas und die Bounding-Box-Korrektur bleiben ebenfalls erhalten.
Es wurden keine Tools entfernt, keine Verbindung neu erstellt und keine
Berechtigungen verändert.

Nach Deployment `e5d9417a-650e-42f7-ae20-56ad34b73f14` wurde in **derselben
ChatGPT-Verbindung** erneut `Aktualisieren` betätigt. Sichtbares Ergebnis:
**„Aktionen aktualisiert.“** Die Oberfläche zeigte danach:

- `search_feature_collections` mit Query-/Limit-Schema;
- aktuelle Beschreibungen für `get_dataset` und `query_features`;
- numerisches `bbox.items` mit exakt vier Einträgen;
- Feldnamen mit Längenangaben/Beschreibung statt Unicode-Pattern;
- keinen alten `create_map_link`-Eintrag mehr.

Damit ist die Unicode-Pattern-Veröffentlichung als verbleibender Auslöser der
beobachteten Import-Inkompatibilität praktisch eingegrenzt. Die erfolgreiche
Claude-Aktualisierung widerspricht dem nicht: Clients können unterschiedliche
Schema-Prüfungen einsetzen. Keine Behauptung über eine konkrete interne
OpenAI-Implementierung oder alle möglichen ungültigen Schemaformen.

## Regression und Grenzen

- TypeScript und 99 Tests in zehn Dateien erfolgreich.
- Echte `tools/list`-Schemas auf portable Arrays und fehlende Unicode-
  Property-Escapes geprüft; Feldnamen-Längengrenzen an beiden Eingabepositionen
  weiterhin veröffentlicht.
- Laufzeitfälle prüfen Umlaute, CJK, Supplementary-Unicode-Buchstaben und
  100/101-Codepunkt-Grenzen sowie Ablehnung von URL-/Query-/Trennzeichen,
  Zeilenumbrüchen und Wildcards.
- Direkter Live-Aufruf nach Deployment: `query_features` erfolgreich, ein Feature.
- Der ChatGPT-Refresh ist direkt im Browser abgenommen. Die zuvor hier im
  Plugin-Connector erhaltenen `Unknown tool`-Fehler sind ein separater
  Registrierungs-/Sitzungsbefund; ein neuer Modellaufruf über diesen Connector
  wurde für diese Abnahme nicht durchgeführt.

Die frühere Einschätzung „vollständig behoben“ nach der Tupel-Korrektur war
zu weitgehend. Direkte MCP-Tests und Neuverbinden ersetzen keinen tatsächlichen
Refresh-Test im betroffenen Client.

Quellen: [JSON Schema: interoperable Regulärausdrücke](https://json-schema.org/understanding-json-schema/reference/regular_expressions),
[Zod: JSON-Schema-Konvertierung und Metadaten](https://zod.dev/json-schema),
[OpenAI: Refresh metadata](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
Beobachtungen und Quellen am 07.09.2026 geprüft.
