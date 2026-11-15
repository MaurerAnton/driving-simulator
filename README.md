# Fahrsim Baunatal

**Freier 3D-Fahrschulsimulator für die Stadt Baunatal – deutsche Verkehrsregeln im echten Straßennetz üben.**
Läuft im Browser, ohne Installation, ohne Konto, ohne Tracking. Freie Software unter **AGPL-3.0-only**.

▶ **Spielen:** <https://maureranton.github.io/driving-simulator/>

*English summary [below](#english).*

| | |
| --- | --- |
| ![Blick über Baunatal mit den Gebäuden aus dem amtlichen 3D-Modell](docs/img/baunatal.jpg) | ![Cockpit mit Instrumenten, Innen- und Außenspiegel, Regel-Hilfe und Karte](docs/img/cockpit.jpg) |

> Der Simulator ersetzt keine Fahrstunde und keine amtliche Prüfung. Er hilft, Regeln und Abläufe zu
> verstehen und zu üben – Verkehrsbeobachtung und Verantwortung lernt man nur im echten Verkehr mit
> einer Fahrlehrerin oder einem Fahrlehrer.

## Was drin ist

- **Baunatal in echt:** alle Straßen der Stadt und ihrer Stadtteile (Altenbauna, Altenritte, Großenritte,
  Kirchbauna, Hertingshausen, Rengershausen, Guntershausen), die A 49 und A 44, Kreisverkehre, das VW-Werk –
  aus OpenStreetMap. Gelände aus dem amtlichen 1-m-Höhenmodell, rund 26 000 Gebäude mit ihren echten Höhen
  und Dachformen aus dem amtlichen 3D-Gebäudemodell (LoD2) des Landes Hessen.
- **Verkehrsregelung am richtigen Ort:** Ampeln, Zebrastreifen, Stopp- und Vorfahrt-gewähren-Schilder,
  Tempolimits, Tempo-30-Zonen, verkehrsberuhigte Bereiche, Einbahnstraßen, Abbiegeverbote und Ortstafeln aus
  den OSM-Daten. Wo OSM nichts sagt, gilt die deutsche Regel – und so stehen dort auch die Schilder
  (siehe [Kartendaten](docs/MAP_DATA.md)).
- **Fahrphysik:** Sechs-Freiheitsgrade-Fahrzeug mit Federung, Reifenmodell (Haft- und Gleitreibung,
  Lastverlagerung), Motor mit Drehmomentkurve, **Kupplung mit Schleifpunkt, Abwürgen und Anlasser**,
  6-Gang-H-Schaltung, ABS, Handbremse, Berganfahren. Wahlweise Kupplungshilfe oder Automatik.
- **Cockpit:** Lenkrad, Schalthebel, Pedale, Handbremse, Kombiinstrument – und **drei funktionierende
  Spiegel**, die optisch korrekt aus der Augposition berechnet werden. Schulterblick per Maus oder Taste.
- **Fahrlehrer im Beifahrersitz:** Der Regelwächter erkennt u. a. zu schnelles Fahren, Rotlicht,
  überfahrene Stoppschilder, missachtete Vorfahrt (Schilder, **rechts vor links**, Kreisverkehr, § 10),
  Fehler beim Abbiegen und Blinken, Zebrastreifen, falsche Fahrtrichtung, Fahren auf dem Gehweg,
  zu geringen Abstand – jeweils mit Erklärung und Fundstelle in der StVO.
- **Fahrstunden und Prüfungsfahrt:** Grundlagen (Anfahren, Schalten, Anhalten), rechts vor links,
  Vorfahrtschilder, Ampeln, Kreisverkehr, Überland, Autobahn – und eine Prüfungsfahrt mit Auswertung.
- **Verkehr:** Fahrzeuge, die Ampeln, Vorfahrt und Abstand beachten, sowie Fußgänger an Überwegen.
- **Realansicht:** „Wie sieht es hier in echt aus?“ – Taste `F` zeigt echte Straßenfotos der Stelle, an der
  das Auto steht: aus den freien Bilddiensten Panoramax, KartaView und Mapillary oder aus eigenen Bildern
  (auch 360°-Panoramen, wie sie Street-View-Downloader speichern). Mehr dazu [unten](#realansicht).
- **Start an jeder Adresse:** Straße und Hausnummer eintippen (rund 8 500 Hausnummern in 530 Straßen aus
  OpenStreetMap) – das Auto steht am Straßenrand vor dem Haus. In der freien Fahrt auch als Sprung aus dem
  Pausenmenü.
- Tastatur, Gamepad, **Lenkrad mit Pedalen und H-Schaltung** (Gamepad-API) und **Touchscreen** – auf dem
  Smartphone ist alles ohne Tastatur erreichbar.
- **28 Sprachen**, vollständig übersetzt – darunter alle Sprachen, in denen man in Deutschland die
  Theorieprüfung ablegen kann. Siehe [Sprachen](#sprachen).

## Steuerung (Tastatur)

| Taste | Funktion |
| --- | --- |
| `W` `S` / `↑` `↓` | Gas / Bremse |
| `A` `D` / `←` `→` | Lenken |
| `Umschalt` | Kupplung (im Modus „Kupplung selbst“) |
| `E` `Q` | Gang hoch / runter (Automatik: Wählhebel) |
| `1`–`6`, `R`, `N` | Gang direkt, Rückwärtsgang, Leerlauf |
| `Leertaste` | Handbremse |
| `Enter` (halten) / `I` | Motor starten / Zündung aus |
| `Y` `C` / `X` | Blinker links / rechts, Warnblinker (unterste Tastenreihe) |
| `J` `K` oder Maus ziehen | Schulterblick links / rechts (beide Tasten: nach hinten) |
| `B` · `L` `O` · `H` | Gurt · Abblend-/Fernlicht · Hupe |
| `V` · `T` · `Esc` | Kamera · Auto zurück auf die Straße · Pause |
| `F` | Realansicht: echte Fotos dieser Stelle |

Beim Fahren mit der Tastatur blendet der Simulator im Stand eine kurze Tastenhilfe ein (Gänge, Handbremse,
Blinker …); sie verschwindet, sobald das Auto rollt, und lässt sich in den Einstellungen abschalten.

### Maus und Touchscreen

| Antippen / Anklicken | Funktion |
| --- | --- |
| Straßenname oben links | Pausenmenü mit Einstellungen, Steuerung, Sprung zu einer Adresse |
| Karte | Realansicht: echte Fotos dieser Stelle |
| Über das Bild wischen | umsehen (Schulterblick); loslassen = wieder geradeaus |
| Gelber Hinweis unten | führt den Hinweis aus (anschnallen, Motor starten, Handbremse lösen …) |

Auf dem Touchscreen liegen links die Lenkleiste und die Blinker, rechts Gas, Bremse, Gänge (▲ ▼) und
Handbremse (P); „⋯“ oben öffnet Gurt, Anlasser, Licht, Warnblinker, Hupe, Kamera und mehr. Die Mitte des
Bildes bleibt frei. Die Bedienelemente erscheinen automatisch, sobald der Bildschirm berührt wird, und
verschwinden, sobald eine Tastatur benutzt wird (praktisch bei Tablets mit Tastatur); in den Einstellungen
lassen sie sich dauerhaft ein- oder ausschalten und in der **Deckkraft** verstellen.

**Hinweise des Fahrlehrers** (Fehler rot, kleinere Fehler und Hinweise gelb) erscheinen in dem Feld, in dem
sonst der Straßenname steht. Treffen mehrere zusammen, wird der schwerwiegendste angezeigt; eine
angekündigte Abbiegung bleibt darunter lesbar.

| | |
| --- | --- |
| ![Smartphone: Lenkleiste und Blinker links, Pedale, Gänge und Handbremse rechts, Hinweis im Straßennamen-Feld](docs/img/smartphone.jpg) | ![PC: Fehlerhinweis im Straßennamen-Feld mit Abbiegeansage, Tastenhilfe unten links, Start an einer Adresse](docs/img/hinweis.jpg) |

## Sprachen

Deutsch · English · Bahasa Indonesia · Čeština · Español · Français · Hrvatski · Italiano · Magyar ·
Nederlands · Polski · Português · Română · Shqip · Tiếng Việt · Türkçe · Ελληνικά · Български · Русский ·
Українська · العربية · فارسی · اردو · हिन्दी · বাংলা · 简体中文 · 日本語 · 한국어

Die Sprache richtet sich beim ersten Start nach dem Browser (wer Serbisch, Bosnisch, Slowakisch oder
Malaiisch eingestellt hat, bekommt die nächstverwandte Sprache) und lässt sich oben im Hauptmenü und in den
Einstellungen umstellen; `?lang=fr` in der Adresse wählt sie für einen Besuch. Übersetzt ist alles: Menüs,
Fahrstunden, die Hinweise des Fahrlehrers mit ihren Erklärungen, die Steuerungsübersicht und die
Realansicht; Strecken, Zeiten und Datumsangaben schreibt der Browser in der Form der jeweiligen Sprache.
Die Fundstellen bleiben in jeder Sprache die deutschen (z. B. „§ 37 Abs. 2 StVO“), ebenso die Nummern der
Verkehrszeichen und natürlich die Straßennamen. Arabisch, Persisch und Urdu werden von rechts nach links
gesetzt; die Bedienelemente behalten dabei ihren Platz. Tasten werden so benannt, wie sie auf der eigenen
Tastatur stehen – gesteuert wird nach der Lage der Taste, auf einer französischen Tastatur also mit Z Q S D
statt W A S D.

| | |
| --- | --- |
| ![Hauptmenü auf Persisch, von rechts nach links gesetzt](docs/img/sprachen-menue.jpg) | ![Smartphone auf Arabisch: roter Hinweis mit deutscher Fundstelle, Bedienelemente an ihrem Platz](docs/img/sprachen-smartphone.jpg) |

Die Übersetzungen wurden maschinell (mit einem KI-Sprachmodell) nach einem Glossar der Fachbegriffe erstellt
und automatisch auf Vollständigkeit, Platzhalter und Länge geprüft, aber **nicht von Muttersprachlern
gegengelesen**. Verbesserungen sind willkommen: eine Sprache ist eine Datei in `src/i18n/`, die Regeln
stehen in [docs/TRANSLATING.md](docs/TRANSLATING.md), `npm run i18n:check` prüft sie.

## Realansicht

Mit `F` (oder im Pausenmenü) öffnet sich die Realansicht für die Stelle, an der das Auto gerade steht – zum
Vergleichen: Welche Schilder stehen dort wirklich, wie sieht die Kreuzung aus?

![Realansicht mit einem gezeichneten 360°-Testbild – echte Fotos werden nicht mit dem Projekt verteilt](docs/img/realansicht.jpg)

- **Freie Bilddienste:** [Panoramax](https://panoramax.fr) und [KartaView](https://kartaview.org) ohne
  Anmeldung, [Mapillary](https://www.mapillary.com) (Meta) mit einem kostenlosen Zugangsschlüssel, den man
  im Fenster einträgt. Die Fotos stehen unter CC BY-SA 4.0 und werden mit Urheber, Datum und Link zum
  Original angezeigt. Panoramax und KartaView haben Bilder aus Baunatal, wenn auch lückenhaft; Mapillary
  ist in deutschen Städten meist am dichtesten abgedeckt.
- **Eigene Bilder:** Fotos und 360°-Panoramen vom eigenen Gerät (JPEG, PNG, WebP) per Dateiauswahl, Ordner
  oder Ziehen ins Fenster – etwa mit *streetview-dl*, *streetviewdownloader* oder einer Browser-Erweiterung
  gespeicherte Panoramen. Position und Blickrichtung werden aus EXIF/XMP, einer beiliegenden Liste (JSON,
  GeoJSON, CSV) oder dem Dateinamen gelesen; Panoramen lassen sich mit der Maus drehen und zeigen zuerst in
  Fahrtrichtung. Die Bilder bleiben auf dem eigenen Gerät. Einzelheiten:
  [public/panos/README.md](public/panos/README.md).
- **Im Browser öffnen:** Links öffnen dieselbe Stelle bei Panoramax, Mapillary, KartaView, Google Street
  View und OpenStreetMap in einem neuen Tab.

**Datenschutz:** Der Simulator selbst ruft nichts ab. Erst wenn man in der Realansicht einen Dienst anhakt,
fragt der Browser diesen direkt – der Dienst erfährt dabei die IP-Adresse und die Stelle auf der Karte.
**Lizenz:** Es werden keine fremden Bilder mit dem Projekt ausgeliefert; Bilder von Google Street View und
anderen nicht frei lizenzierten Quellen kann man für sich selbst laden, aber nicht weitergeben.

Wer eine eigene Kopie betreibt, kann einen Mapillary-Schlüssel als Repository-Variable `MAPILLARY_TOKEN`
hinterlegen (er wird beim Bauen als `VITE_MAPILLARY_TOKEN` eingesetzt) und eigene, frei lizenzierte Bilder
über `public/panos/` und `npm run panos:index` für alle Besucher bereitstellen.

## Lokal starten

Voraussetzung: [Node.js](https://nodejs.org) ≥ 24.

```bash
git clone https://github.com/MaurerAnton/driving-simulator.git
cd driving-simulator
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # statische Seite in dist/
```

Die fertige Karte liegt im Repository (`public/map`), zum Spielen und Entwickeln müssen keine Geodaten
geladen werden.

### Tests

```bash
npm test             # 55 Tests: Fahrdynamik (21), Realansicht (15), Adresssuche und Hinweise (9), Sprachen (10)
npm run i18n:check   # Übersetzungen prüfen (Vollständigkeit, Platzhalter, Längen)
npm run test:traffic # Verkehrssimulation im Dauerlauf auf der echten Karte
npm run test:drive   # „virtueller Fahrschüler“ fährt alle Fahrstunden regelkonform ab
```

## Karte neu erzeugen

Die Karte entsteht vollständig automatisch aus offenen Daten – auch für andere hessische Gemeinden
anpassbar. Details, Download-Befehle und Lizenzen: **[docs/MAP_DATA.md](docs/MAP_DATA.md)**.

```bash
npm run map:all    # OSM-Auszug schneiden → LoD2 einlesen → Karte bauen → Adressliste (ca. 5 Minuten)
```

**Ein Schild fehlt oder steht falsch?** Die Verkehrsregelung kommt aus OpenStreetMap. Am nachhaltigsten ist
es, den Fehler dort zu beheben (z. B. `highway=give_way` mit `direction`, `maxspeed`, `traffic_sign`) –
davon profitieren alle Karten und Navis. Nach dem nächsten Kartenlauf ist er auch hier korrigiert.

## Aufbau

```
src/geo, src/core      Projektion (ETRS89/UTM32), Geometrie
src/world              Straßennetz-Modell: Knoten, Kanten, Kreuzungsgeometrie, Fahrstreifen, Vorfahrt
src/sim/vehicle        Fahrdynamik (ohne Abhängigkeiten, deterministisch)
src/sim                Verkehr, Ampeln, Regelwächter, Kollisionen
src/render             three.js: Kacheln, Gebäude, Schilder, Fahrzeug, Cockpit, Spiegel
src/i18n               Texte: eine Datei je Sprache, Tastenbeschriftung nach Tastaturbelegung
src/reality            Realansicht: Bild-Metadaten (EXIF/XMP), eigene Bilder, freie Bilddienste
src/game, src/ui       Spielablauf, Fahrstunden, Navigation, HUD, Menüs, Texte (de/en)
tools/                 Kartenpipeline (OSM-PBF-Leser, Höhenmodell, LoD2, Straßennetz, 3D-Netze, Kacheln),
                       Verzeichnis eigener Straßenbilder (tools/panos)
tests/                 Fahrdynamik-Tests, Verkehrs-Dauerlauf, virtueller Fahrschüler
```

Dieselbe Geometrie- und Vorfahrtlogik läuft in der Kartenpipeline, in der Physik, im Verkehr und im
Regelwächter – was man sieht, worauf die Reifen stehen und wonach bewertet wird, ist deshalb identisch.

## Stand und bekannte Grenzen

- **Automatisch geprüft:** 21 Abnahmetests der Fahrdynamik, ein Dauerlauf des Umgebungsverkehrs und ein
  „virtueller Fahrschüler“, der alle Fahrstunden und die Prüfungsfahrt (zusammen rund 48 km) regelkonform
  abfährt, ohne dass der Regelwächter einen Fehler meldet.
- **Ergänzte Regelung:** Was in OpenStreetMap nicht erfasst ist (etwa ein fehlendes Vorfahrtschild), wird
  nach den Grundregeln der StVO ergänzt und kann von der Wirklichkeit abweichen. Ampeln laufen mit
  plausiblen Festzeiten, nicht mit der echten Schaltung.
- **Umgebungsverkehr:** beachtet Vorfahrt, Ampeln und Abstand, ist an großen Knotenpunkten aber nicht
  fehlerfrei – vereinzelt blockieren sich Fahrzeuge oder kommen sich zu nahe. Fußgänger gibt es nur an
  Überwegen, Radfahrer noch nicht.
- **Darstellung:** Gebäude haben echte Form und Höhe, aber keine Fototexturen; Fahrzeug und Cockpit sind
  bewusst schlicht und vollständig prozedural erzeugt.

## Lizenz

- **Programm:** GNU Affero General Public License, Version 3 – ausschließlich diese Version
  (`AGPL-3.0-only`), siehe [LICENSE](LICENSE). Wer eine veränderte Fassung im Netz betreibt, muss deren
  Quelltext anbieten.
- **Kartendaten** (`public/map`): abgeleitete Datenbank aus © OpenStreetMap-Mitwirkende,
  [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); Gelände und Gebäude aus offenen Geobasisdaten
  der Hessischen Verwaltung für Bodenmanagement und Geoinformation.
- **Verkehrszeichen** (`public/signs`): amtliche Werke, gemeinfrei (§ 5 Abs. 1 UrhG), Grafiken von
  Wikimedia Commons.
- **Straßenfotos der Realansicht:** nicht Teil des Projekts – sie werden auf Wunsch live von Panoramax,
  KartaView oder Mapillary geladen (CC BY-SA 4.0, Urheber wird angezeigt) oder stammen vom eigenen Gerät.
- **Abhängigkeiten:** three.js (MIT). Es werden keine Schriften, Texturen, Modelle oder Tondateien
  mitgeliefert – alles wird zur Laufzeit erzeugt.

Einzelheiten: [NOTICE.md](NOTICE.md).

---

<a id="english"></a>

## English

**Fahrsim Baunatal** is a free (AGPL-3.0-only) browser-based 3D driving-school simulator set in the real
German town of Baunatal near Kassel. It is meant to help learner drivers understand and practise German
traffic rules (StVO).

- The real road network with its traffic lights, signs, speed limits, zones, one-way streets and
  roundabouts from OpenStreetMap; terrain from the official 1 m elevation model and about 26,000 buildings
  with real heights and roof shapes from the State of Hesse's open LoD2 model.
- A physically based car: 6-DOF body, suspension, tyre model, engine, **clutch with biting point and
  stalling**, 6-speed H-gate gearbox, ABS, hill starts; clutch assist or automatic optional.
- A full cockpit with steering wheel, shifter, pedals, instruments and **three working mirrors**.
- A rule monitor that explains every mistake with its legal basis: speeding, red lights, stop signs, right
  of way (signs, *right before left*, roundabouts), indicating, pedestrian crossings, wrong-way driving …
- Lessons, a simulated driving test, ambient traffic and pedestrians, keyboard / gamepad / wheel / touch.
  On a phone everything works without a keyboard: tap the street name for the menu, the map for real
  photos, swipe to look around; the on-screen controls leave the middle of the picture free and their
  opacity can be set. With a keyboard they hide and a short key reminder is shown instead.
- Start at any address: type a street and house number (about 8,500 house numbers from OpenStreetMap).
- The instructor's notices (red for serious faults, yellow for minor ones) appear in the street-name block;
  if several coincide, the gravest is shown.
- **28 languages**, fully translated (all the languages of the German theory test among them, and
  right-to-left layout for Arabic, Persian and Urdu); the translations are machine-made from a glossary and
  checked automatically, not proof-read by native speakers – see
  [docs/TRANSLATING.md](docs/TRANSLATING.md) to improve one or add another.
- A **reality view** (key `F`): real street-level photographs of the place the car is at – from the free
  imagery services Panoramax, KartaView and Mapillary (CC BY-SA 4.0, only requested when you switch a
  service on) or from your own files, including 360° panoramas saved with street-view download tools
  (they stay on your device); plus links that open the place at those services and in Google Street View.

Verified automatically by 21 vehicle-dynamics acceptance tests, a traffic soak run and a "virtual learner
driver" that completes every lesson and the driving test (about 48 km in total) without a single fault being
reported. Known limits: rules missing in OpenStreetMap are filled in from the general StVO rules and may
differ from reality, traffic-light timings are plausible fixed cycles, the ambient traffic is not perfect at
large junctions, and there are no cyclists yet.

Play at <https://maureranton.github.io/driving-simulator/>, or run locally with `npm install && npm run dev`
(Node.js ≥ 24). The map is generated by the pipeline in `tools/` from open data only; see
[docs/MAP_DATA.md](docs/MAP_DATA.md). The simulator is no substitute for lessons with an instructor.
