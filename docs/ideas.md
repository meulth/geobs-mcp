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

## Erledigt

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
