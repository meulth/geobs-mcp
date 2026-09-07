# Ideensammlung für GeoBS-MCP

Stand: 7. September 2026.

Dieses Dokument ist die zentrale Sammlung für Projektideen und die Grundlage
für Antworten an `dashboard-guy`. Vor einer solchen Antwort den aktuellen
Stand hier lesen. Nur offene, noch nicht laufende Ideen als neue Aufgaben
vorschlagen; erledigte oder unerwünschte Arbeiten nicht erneut anbieten.
Ungeprüfte Annahmen und bekannte Grenzen ausdrücklich nennen.

Ein Eintrag ist kein Umsetzungsauftrag. Bei neuen Erkenntnissen, Beginn oder
Abschluss einer Arbeit den Status und das Datum hier aktualisieren.
Neue Ideen erhalten eine dauerhafte ID, Priorität, Status, Begründung,
bekannte Grenzen und einen direkt kopierbaren Nutzerprompt.

## Grundlage und Auswahl

Am 07.09.2026 mit dem lokalen Code (Stand `c2e306e`), `README.md`,
`docs/workflow.md` und `docs/api-analysis.md` abgeglichen. Die fünf vorhandenen
Tools, Grafana-Anbindung und Schema-Korrektur werden nicht erneut vorgeschlagen.
Für diese Ideenpflege keine Live-Datenquellen abgefragt. Katalogbeobachtungen
in `api-analysis.md` stammen vom 28.08.2026 und sind kein aktueller
Verfügbarkeitsnachweis. Alle unten offenen Ideen sind noch nicht begonnen;
keine laufenden oder abgelehnten Arbeiten sind in dieser Sammlung dokumentiert.

GEO-005 ist inzwischen umgesetzt und live abgenommen (siehe Erledigt).
Empfohlener Einstieg: **GEO-001** (bekannter Auswahlfehler).
**GEO-010** ist eine produktnahe Alternative für einen
direkt nutzbaren Adressbericht. Die experimentellen Ideen GEO-013 bis GEO-015
beginnen bewusst mit einer kleinen Machbarkeitsprüfung.

| ID | Idee | Priorität | Einordnung / wichtigste Abhängigkeit |
| --- | --- | --- | --- |
| GEO-001 | Grundstücks-Collection zuverlässig auswählen | mittel | Bekannten Gleichstandsfall reproduzieren |
| GEO-006 | Zulässige Filter und Felder erklären | mittel | Queryables/Schema-Verfügbarkeit erst prüfen |
| GEO-007 | Echte Umkreissuche | mittel | Geometrien und korrekte Distanzberechnung |
| GEO-008 | Begrenzte, nachvollziehbare Statistiken | mittel | Vollständige Datengrundlage oder klare Teilmenge |
| GEO-009 | Rasterwerte für einen Ort erschliessen | niedrig | Abfragbarer Rasterdienst noch nicht nachgewiesen |
| GEO-010 | Adressdossier mit Quellen und Lücken | mittel | Bestehende Toolfolge; Grundstücksauflösung prüfen |
| GEO-011 | Zwei Orte fair vergleichen | niedrig | Gleiche Datenstände, Flächen und Abdeckung |
| GEO-012 | Kleine Kartenansicht zum Mitnehmen | niedrig | Koordinaten, Geometrien und Nutzungsrechte |
| GEO-013 | Veränderungen als Geo-Zeitlupe | niedrig | Experimentell; zwei vergleichbare Datenstände |
| GEO-014 | Datenlücken-Spaziergang | niedrig | Experimentell; öffentliche Orte, kein Routing vorhanden |
| GEO-015 | Was wäre, wenn dieser Platz grüner wäre? | niedrig | Experimentell; Flächenszenario mit offenen Annahmen |

## Offen

### GEO-001: Grundstücks-Collection zuverlässiger auswählen

- **Priorität:** mittel.
- **Status:** offen; keine Umsetzung begonnen.
- **Letzter Stand:** 07.09.2026, aus dem bisherigen Projekt-/Gesprächsstand.
- **Befund:** Bei gleich bewerteten OGC-Collections kann die bestehende
  Grundstückserkennung eine Grenzpunkt- statt einer Grundstücks-Collection
  auswählen. Das kann die Grundstücksabfrage fehlleiten.
- **Grenzen:** Der bekannte Fall wurde für diese Ideensammlung nicht erneut
  reproduziert. Zuerst die aktuelle Auswahl und echte Collection-Metadaten
  prüfen; die konkrete Korrektur ergibt sich aus diesem Befund.
- **Nutzerprompt:**

> Prüfe im geobs-mcp die Auswahl der Grundstücks-Collection. Reproduziere den
> bekannten Gleichstandsfall zwischen Grenzpunkten und Grundstücken, korrigiere
> die Auswahl nachvollziehbar und sichere sie mit einem gezielten
> Regressionstest ab. Zunächst nur lokale Änderungen, kein Commit oder Deploy.

### GEO-006: Zulässige Filter und Felder erklären

- **Priorität / Status:** mittel / offen.
- **Nutzen:** Der MCP-Client soll Filter nicht anhand vermuteter Feldnamen
  ausprobieren müssen. Derzeit darf das Upstream-API unbekannte Felder ablehnen.
- **Erster Schritt / Grenzen:** Für eine Collection prüfen, ob Queryables oder
  ein verlässliches Schema verfügbar sind. Ein Feld in einem Beispieldatensatz
  beweist weder Filterbarkeit noch vollständige Wertebereiche.
- **Nutzerprompt:**

> Prüfe für geobs-mcp an einer ausgewählten OGC-Collection, welche offiziellen
> Metadaten Filterfelder, Typen und mögliche Werte beschreiben. Erstelle einen
> Vorschlag für eine kompakte Feldauskunft und prototypisiere sie lokal nur bei
> belastbarer Quelle. Trenne deklarierte Filter von bloss beobachteten Feldern.
> Bestehende Filterlimits beibehalten; kein Commit oder Deployment.

### GEO-007: Echte Umkreissuche

- **Priorität / Status:** mittel / offen.
- **Nutzen:** Auf „Was liegt höchstens 300 Meter entfernt?“ mit Distanzangaben
  antworten. `query_features` rechnet den Radius bisher in eine quadratische
  Bounding Box um; das ist noch kein exakter Kreis oder Fussweg.
- **Erster Schritt / Grenzen:** Eine Punkt-Collection in EPSG:2056 und ein
  kleiner Suchradius. Kandidaten ausserhalb des Kreises entfernen und sortieren.
  Das 25-Feature-Limit kann Treffer verbergen; unvollständige Abdeckung anzeigen.
- **Nutzerprompt:**

> Entwirf und prototypisiere lokal eine echte Umkreissuche für geobs-mcp,
> zunächst für Punktgeometrien in EPSG:2056. Filtere Bounding-Box-Kandidaten
> anhand der Luftlinienentfernung, liefere Meter und eine Distanzsortierung.
> Prüfe Kreisrand und Boxecken und kennzeichne mögliche fehlende Treffer durch
> Upstream-Limits. Keine Fusswegzeiten behaupten; kein Commit oder Deployment.

### GEO-008: Begrenzte, nachvollziehbare Statistiken

- **Priorität / Status:** mittel / offen.
- **Nutzen:** Zählungen und einfache Summen für ein Gebiet liefern, ohne dass
  der Chat einzelne Features zusammensuchen muss.
- **Erster Schritt / Grenzen:** Eine Collection, ein Gebiet, Zählung und eine
  numerische Kennzahl. Prüfen, ob serverseitige Aggregation oder begrenztes
  Nachladen möglich ist. 25 zurückgegebene Features sind keine Gebietsgesamtheit.
- **Nutzerprompt:**

> Prüfe für geobs-mcp eine begrenzte Statistikfunktion für eine Collection und
> ein kleines Gebiet: Anzahl und Summe eines explizit gewählten Zahlenfelds.
> Kläre zuerst Pagination bzw. serverseitige Aggregation. Implementiere einen
> lokalen Prototyp mit Aufruf-, Byte- und Zeitbudget sowie Vollständigkeitsflag.
> Weise Teilmengen als solche aus und lehne ungeeignete Felder ab. Kein freies
> SQL, kein Commit oder Deployment.

### GEO-009: Rasterwerte für einen Ort erschliessen

- **Priorität / Status:** niedrig / offen, von Datenzugang abhängig.
- **Nutzen:** Auch Produkte erschliessen, die als Raster statt als Features
  angeboten werden; beispielsweise Umweltinformationen, falls verfügbar.
- **Erster Schritt / Grenzen:** Ein Produkt und ein Punkt. WMS-Bilder sind
  nicht automatisch numerisch abfragbare Raster; Einheit, NoData, Auflösung
  und zeitliche Aussage müssen geklärt sein. Kein Lärm-/Hitzedienst zugesichert.
- **Nutzerprompt:**

> Untersuche anhand eines geeigneten GeoBS-Produkts, ob sich für einen Punkt
> ein dokumentierter Rasterwert abrufen lässt. Prüfe Dienst, Nutzungsrecht,
> CRS, Einheit, Auflösung, Datenstand und NoData-Verhalten. Liefere zunächst
> eine Machbarkeitsnotiz mit einer begrenzten Beispielabfrage; bei fehlender
> Quelle kein Tool erfinden. Noch keine Implementierung oder Bereitstellung.

### GEO-010: Adressdossier mit Quellen und Lücken

- **Priorität / Status:** mittel / offen.
- **Nutzen:** Die bestehende Toolfolge zu einem prüfbaren, wiederverwendbaren
  Bericht bündeln: Was wissen die Daten über eine Adresse, was fehlt?
- **Erster Schritt / Grenzen:** Eine öffentliche Beispieladresse, maximal drei
  Themen, zunächst lokales Markdown. Zeitstand je Quelle und Unterschied zwischen
  „keine Treffer“, „nicht abgefragt“ und „Abfrage fehlgeschlagen“ ausweisen.
  GEO-001 berücksichtigen, bevor Grundstücksdaten automatisch zugeordnet werden.
- **Nutzerprompt:**

> Erstelle für geobs-mcp einen lokalen Prototyp eines Adressdossiers als
> Markdown anhand einer öffentlichen Beispieladresse und höchstens drei Themen.
> Verwende die bestehenden Tools und zeige pro Aussage Quelle, Datenstand,
> räumlichen Bezug und Abfragegrenzen. Markiere fehlende oder widersprüchliche
> Daten ausdrücklich und bestätige die Grundstückszuordnung. Kein zusätzliches
> LLM im Worker, kein automatischer Versand, kein Commit oder Deployment.

### GEO-011: Zwei Orte fair vergleichen

- **Priorität / Status:** niedrig / offen, von vergleichbaren Daten abhängig.
- **Nutzen:** Zwei Orte anhand transparenter Merkmale gegenüberstellen, etwa
  beobachtete Objekte pro gleich grosser Fläche, statt einen unbegründeten
  Gesamtscore für „Lebensqualität“ zu erzeugen.
- **Erster Schritt / Grenzen:** Zwei gleich grosse Gebiete und zwei Merkmale.
  GEO-007/GEO-008 oder gleichwertige Vollständigkeitsprüfung erforderlich,
  wenn Distanzen oder Gesamtzahlen verwendet werden. Gewichtungen sind subjektiv.
- **Nutzerprompt:**

> Entwirf für geobs-mcp einen Vergleich zweier gleich grosser Gebiete mit
> höchstens zwei nachweislich verfügbaren Indikatoren. Prüfe zuerst Abdeckung,
> Definition, Einheit und Datenstand. Erstelle eine lokale Vergleichstabelle
> mit Quellen und fehlenden Werten; keine Rangliste bei ungleichen Grundlagen
> und keinen undokumentierten Gesamtscore. Noch kein neues Tool oder Deployment.

### GEO-012: Kleine Kartenansicht zum Mitnehmen

- **Priorität / Status:** niedrig / offen.
- **Nutzen:** Ein Ergebnis räumlich nachvollziehen und als einzelne Datei
  weitergeben können, ohne einen neuen Kartenserver zu betreiben.
- **Erster Schritt / Grenzen:** Lokale HTML-/SVG-Karte mit einem Suchpunkt,
  Abfragegebiet und wenigen Features. Massstab, CRS und Quellen ausweisen.
  Hintergrundkarten und deren Nutzungsrechte separat prüfen; keine externe
  Übertragung der dargestellten Adresse durch eingebundene Dienste voraussetzen.
- **Nutzerprompt:**

> Baue aus einem kleinen GeoBS-Abfrageergebnis eine eigenständige lokale
> Kartenansicht als HTML oder SVG: Suchpunkt, Abfragegebiet, wenige Features,
> Legende, Massstab und Quellen. Kläre CRS und Geometrievereinfachung und
> verwende zunächst keinen externen Kartendienst. Daten sicher als Inhalt
> behandeln. Ziel ist eine Beispieldatei, kein Hosting oder Deployment.

### GEO-013: Veränderungen als Geo-Zeitlupe — experimentell

- **Priorität / Status:** niedrig / offen, zwei Datenstände erforderlich.
- **Nutzen:** Sichtbar machen, was sich zwischen zwei Abfragen geändert hat:
  neue/entfallene Objekte, Attribute oder Geometrien mit Quellenbeleg.
- **Erster Schritt / Grenzen:** Zwei lokale, bewusst gespeicherte Snapshots
  einer kleinen Collection. Historische Stände sind nicht garantiert vorhanden.
  Unterschiedliche Erfassungsmethoden und IDs können scheinbare Änderungen
  erzeugen; ein Datenunterschied beweist keine reale bauliche Veränderung.
- **Nutzerprompt:**

> Entwirf eine Geo-Zeitlupe für geobs-mcp: Vergleiche zwei lokale Snapshots
> derselben kleinen Collection und trenne neue, entfernte und veränderte
> Features. Prüfe stabile IDs, Abdeckung, CRS und Datenstand, bevor du einen
> fachlichen Unterschied behauptest. Nutze bereitgestellte oder explizit
> erstellte Beispielsnapshots und liefere einen lokalen Differenzbericht.
> Keine historische Datenverfügbarkeit voraussetzen, kein Dauerbetrieb.

### GEO-014: Datenlücken-Spaziergang — experimentell

- **Priorität / Status:** niedrig / offen.
- **Nutzen:** Geo-Daten zum Erkunden nutzen: Drei öffentliche Beobachtungsorte
  und Fragen, die man vor Ort beantworten kann, etwa ob ein Kartenmerkmal
  tatsächlich sichtbar ist. Aus Unsicherheit wird eine überprüfbare Frage.
- **Erster Schritt / Grenzen:** Eine kleine Gegend, drei Stationen aus belegten
  Daten. Öffentliche Zugänglichkeit und sichere Verbindungen sind nicht aus
  blosser Nähe ableitbar. Kein Routing- oder aktueller Sperrungsdienst vorhanden.
- **Nutzerprompt:**

> Erstelle mit vorhandenen GeoBS-Daten einen lokalen Prototyp für einen
> Datenlücken-Spaziergang in einer kleinen Gegend: drei mögliche öffentliche
> Beobachtungsorte, je eine belegte Karteninformation und eine offene Frage.
> Prüfe die Datenbasis und kennzeichne ungeklärte Zugänglichkeit. Liefere
> Stationskarten statt einer vermeintlich geprüften Gehroute. Keine Personen-
> oder Bewohnerdaten sammeln und keine Änderungen an amtliche Stellen senden.

### GEO-015: Was wäre, wenn dieser Platz grüner wäre? — experimentell

- **Priorität / Status:** niedrig / offen, geeignete Flächendaten erforderlich.
- **Nutzen:** Ein hypothetisches Entsiegelungs- oder Begrünungsszenario als
  nachvollziehbare Flächenrechnung erkunden: Welche Flächenanteile ändern sich?
- **Erster Schritt / Grenzen:** Ein Nutzerpolygon, vorhandene Bodenbedeckung
  und eine frei gewählte Szenariofläche. Überlappungen und Flächensummen prüfen.
  Daraus folgen keine belastbaren Aussagen über Temperatur, Kosten,
  Genehmigungsfähigkeit oder tatsächliche Nutzungsmöglichkeiten.
- **Nutzerprompt:**

> Prüfe einen kleinen lokalen GeoBS-Prototyp für ein hypothetisches
> Begrünungsszenario auf einer ausgewählten Fläche. Kläre zunächst geeignete
> Bodenbedeckungsdaten und Nutzungsrechte. Stelle Ist-Flächen und eine explizit
> vorgegebene Szenariofläche samt Annahmen gegenüber; prüfe Überlappungen und
> Flächenbilanz. Kein Klimaversprechen und keine Bauempfehlung. Nur lokale
> Machbarkeitsnotiz und Beispielrechnung, keine Bereitstellung.

## Erledigt

### GEO-005: OGC-Layer direkt finden

- **Priorität / Status:** mittel / erledigt am 07.09.2026 nach Nutzerfreigabe
  „ok, setz das um.“
- **Umsetzung:** Sechstes Tool `search_feature_collections`, dynamische Suche
  in ID, Titel und Beschreibung, exakte IDs, feldbezogene Treffergründe,
  Standardlimit 8 / maximal 20 und explizite Treffer-/Kürzungsangaben.
- **Cache:** Gemeinsamer vollständiger KV-Katalog auch für `get_dataset` und
  punktbasierte Grundstücks-Layer-Erkennung. Refresh Mittwoch 03:00 Europe/Zurich,
  inklusive Sommer-/Winterzeit. Quelle laut Nutzer höchstens dienstags geändert.
  Features bleiben live, MCP-Endpunkt unverändert. Kein kostenpflichtiges Abo
  eingerichtet; tatsächliche Kosten hängen von Tarif und Gesamtnutzung ab.
- **Abnahme:** 84 Tests und Typecheck erfolgreich; 894 Collections in Remote-KV.
  Live-MCP liefert alle sechs Tools, 21 AVPZ-Layer (20 ausgegeben, Kürzung gemeldet),
  exakten Grundstücks-Layer und erfolgreiche anschliessende Feature-Abfragen.
  Deployment `4846f583-cf62-43aa-a6c6-b9558201039e`.
- **Grenzen:** Keine semantischen Synonyme, Volltextsuche in Features oder
  garantierte fachliche Eignung. Alter wird angezeigt; über 14 Tage alter Cache
  wird abgelehnt. Fehlgeschlagener Refresh erhält den letzten guten Stand.
  GEO-001 bleibt separat offen. Erster regulärer Cron-Lauf ist erst am 09.09.2026;
  dessen tatsächliche Ausführung ist noch nicht beobachtet.
- **Dokumentation:** [Analyse](ogc-collection-search-analysis.md),
  [Umsetzung und Betrieb](ogc-catalog.md), [Monitoring-Vertrag](monitoring.md).

### GEO-002: Nutzung und Betrieb in Grafana anzeigen

- **Status:** erledigt am 06.09.2026.
- **Ergebnis:** Strukturierte HTTP-, Tool- und GeoBS-Metriken im produktiven
  Worker; Collector mit Fünf-Minuten-Takt und Grafana-Dashboard mit 22 Panels.
- **Quelle:** Worker-Abnahme hier und Abschlussmeldung von `infra-services-vm`.
- **Details:** [Monitoring-Datenvertrag und Abnahme](monitoring.md).
- **Abgrenzung:** Zusätzliche Mailalarme wurden nicht beauftragt.

### GEO-003: Produktiven Monitoring-Code in Git sichern

- **Status:** erledigt am 07.09.2026; `dashboard-guy` informiert.
- **Ergebnis:** Commit `8a2327e` auf `origin/main` gepusht, lokaler und
  entfernter Stand identisch, Arbeitsverzeichnis zum Abschluss sauber.
  Typecheck und 43 Tests bestanden. Grafana-Betrieb dokumentiert.
- **Deployment:** Kein neues Deployment nötig; unveränderter Laufzeitcode
  bereits produktiv als Version `dc0d3abb-9555-4ede-958e-b26d84d9d080`.

### GEO-004: Tool-Schema in ChatGPT und Claude aktualisieren

- **Status:** erledigt am 07.09.2026; Nutzer hat die Funktion beider Clients
  nach der Korrektur bestätigt (Claude direkt aktualisiert, ChatGPT neu verbunden).
- **Ergebnis:** Feste Zahlenarrays statt Tupel-`prefixItems` für Bounding Box
  und Koordinaten. 48 Tests bestanden, veröffentlichte Schemas live geprüft.
- **Git / Deployment:** Commit `c2e306e` gepusht und Version
  `b8944468-4ee9-411d-80a0-e9bdfdde5e86` deployed. Dies ersetzt den in GEO-003
  beschriebenen damaligen Produktionsstand; keine neue offene Refresh-Aufgabe.

## Vorlage für weitere Ideen

```text
### GEO-XXX: Kurzer Titel

- Priorität: hoch / mittel / niedrig.
- Status: offen / läuft / erledigt / zurückgestellt / unerwünscht.
- Letzter Stand: Datum und Quelle.
- Nutzen oder Befund:
- Bekannte Grenzen und Abhängigkeiten:
- Nutzerprompt: Konkreter, direkt kopierbarer Auftrag.
```
