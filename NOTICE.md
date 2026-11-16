# Rechtliche Hinweise / Notices

## Programm

Fahrsim Baunatal – Copyright (C) 2026 die Mitwirkenden des Projekts.

Dieses Programm ist freie Software: Sie können es unter den Bedingungen der **GNU Affero General Public
License, Version 3** (ausschließlich dieser Version, SPDX `AGPL-3.0-only`), wie von der Free Software
Foundation veröffentlicht, weitergeben und/oder verändern. Es wird in der Hoffnung verbreitet, dass es
nützlich ist, aber OHNE JEDE GEWÄHRLEISTUNG. Den vollständigen Text enthält die Datei [LICENSE](LICENSE).

Wer eine veränderte Fassung über ein Netzwerk zur Benutzung anbietet, muss den Benutzerinnen und Benutzern
den zugehörigen Quelltext zugänglich machen (§ 13 AGPL). Der Quelltext dieser Fassung:
<https://github.com/MaurerAnton/driving-simulator>.

## Daten in `public/map`

Die Kartendaten sind eine aus OpenStreetMap abgeleitete Datenbank und stehen unter der **Open Database
License 1.0** – © OpenStreetMap-Mitwirkende, <https://www.openstreetmap.org/copyright>.

Geländehöhen (DGM1) und Gebäude (3D-Gebäudemodelle LoD2): Hessische Verwaltung für Bodenmanagement und
Geoinformation, offene Geobasisdaten nach § 18 HVGG („jede Nutzung ohne Einschränkung oder Bedingung“).

Die Herleitung beschreibt [docs/MAP_DATA.md](docs/MAP_DATA.md).

## Verkehrszeichen in `public/signs`

Die Verkehrszeichen der StVO sind amtliche Werke und nach § 5 Abs. 1 UrhG gemeinfrei. Die Vektorgrafiken
stammen von Wikimedia Commons; Datei, Quelle und Lizenzangabe jedes Zeichens stehen in
`public/signs/manifest.json`.

## Straßenfotos in der Realansicht

Das Projekt enthält und verteilt keine Straßenfotos. Die Realansicht lädt sie auf Wunsch der Spielerin oder
des Spielers direkt im Browser von

- [Panoramax](https://panoramax.fr) (föderiert, u. a. OpenStreetMap France und IGN) – CC BY-SA 4.0 bzw.
  Licence Ouverte 2.0, je nach Instanz;
- [KartaView](https://kartaview.org) – CC BY-SA 4.0;
- [Mapillary](https://www.mapillary.com) (Meta) – CC BY-SA 4.0, Abruf mit eigenem Zugangsschlüssel

und zeigt sie mit Urheber, Lizenz und Link zum Original an. Eigene Bilder der Nutzer (etwa selbst
gespeicherte Street-View-Panoramen) werden nur lokal im Browser gelesen; für deren Rechte sind die Nutzer
selbst verantwortlich. Der Ordner `public/panos/` ist deshalb von der Versionsverwaltung ausgenommen.

## Luftbilder auf der großen Karte

Das Projekt enthält und verteilt keine Luftbilder. Wer auf der großen Karte „Luftbilder“ anhakt, lässt sie
direkt im eigenen Browser vom WMS-Dienst der Hessischen Verwaltung für Bodenmanagement und Geoinformation
laden (Digitale Orthophotos DOP20, <https://hvbg.hessen.de>): offene Geobasisdaten, „jede Nutzung … ohne
Einschränkung oder Bedingung erlaubt“ (§ 24 HVGG). Die Karte nennt die Herkunft der Bilder.

## Verweise auf Rechtsvorschriften

Das Fehlerprotokoll verlinkt die zitierten Paragrafen der Straßenverkehrs-Ordnung auf
<https://www.gesetze-im-internet.de/stvo_2013/> und – bei den Aufgaben der Klasse CE – die Anlage 7 der
Fahrerlaubnis-Verordnung auf <https://www.gesetze-im-internet.de/fev_2010/> (Bundesministerium der Justiz,
Bundesamt für Justiz). Der Text der Vorschriften ist nicht Teil des Projekts.

## Fremde Software

| Paket | Verwendung | Lizenz |
| --- | --- | --- |
| [three.js](https://threejs.org) | 3D-Darstellung im Browser | MIT |
| [Vite](https://vite.dev), [TypeScript](https://www.typescriptlang.org) | Bauen (nur Entwicklung) | MIT, Apache-2.0 |
| [saxes](https://github.com/lddubeau/saxes), [earcut](https://github.com/mapbox/earcut) | Kartenpipeline (nur Entwicklung) | ISC, ISC |
| [Pillow](https://python-pillow.github.io), [NumPy](https://numpy.org) | Geländedaten laden und verkleinern (`tools/fetch-geodata.py`, nur beim Kartenbau; nicht mitgeliefert) | MIT-CMU, BSD-3-Clause |
| [Playwright](https://playwright.dev) | Bildschirmfotos beim Entwickeln | Apache-2.0 |

Das ausgelieferte Spiel enthält keine Schriften, Texturen, 3D-Modelle oder Tonaufnahmen Dritter: Flächen,
Fahrzeuge, Gebäudefassaden und alle Geräusche werden zur Laufzeit erzeugt.

## Haftungsausschluss

Der Simulator dient dem Üben und ersetzt weder die Ausbildung in einer Fahrschule noch die amtliche
Prüfung. Die dargestellte Verkehrsregelung kann von der Wirklichkeit abweichen; maßgeblich sind immer die
Schilder und Zeichen vor Ort und die geltende Straßenverkehrs-Ordnung.
