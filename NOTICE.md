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

## Fremde Software

| Paket | Verwendung | Lizenz |
| --- | --- | --- |
| [three.js](https://threejs.org) | 3D-Darstellung im Browser | MIT |
| [Vite](https://vite.dev), [TypeScript](https://www.typescriptlang.org) | Bauen (nur Entwicklung) | MIT, Apache-2.0 |
| [geotiff.js](https://geotiffjs.github.io), [saxes](https://github.com/lddubeau/saxes), [earcut](https://github.com/mapbox/earcut) | Kartenpipeline (nur Entwicklung) | MIT, ISC, ISC |
| [Playwright](https://playwright.dev) | Bildschirmfotos beim Entwickeln | Apache-2.0 |

Das ausgelieferte Spiel enthält keine Schriften, Texturen, 3D-Modelle oder Tonaufnahmen Dritter: Flächen,
Fahrzeuge, Gebäudefassaden und alle Geräusche werden zur Laufzeit erzeugt.

## Haftungsausschluss

Der Simulator dient dem Üben und ersetzt weder die Ausbildung in einer Fahrschule noch die amtliche
Prüfung. Die dargestellte Verkehrsregelung kann von der Wirklichkeit abweichen; maßgeblich sind immer die
Schilder und Zeichen vor Ort und die geltende Straßenverkehrs-Ordnung.
