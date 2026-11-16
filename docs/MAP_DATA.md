# Kartendaten: Quellen, Lizenzen, Pipeline

Die Karte in `public/map` wird vollständig automatisch aus offenen Daten erzeugt. Dieses Dokument
beschreibt, woher die Daten kommen, was daraus abgeleitet wird und wie man die Karte neu baut.

## Quellen

| Inhalt | Quelle | Lizenz |
| --- | --- | --- |
| Straßen, Fahrstreifen, Tempolimits, Ampeln, Schilder, Abbiegeverbote, Überwege, Flächennutzung, Bäume, Bahn | [OpenStreetMap](https://www.openstreetmap.org), Auszug „Hessen“ von [Geofabrik](https://download.geofabrik.de/europe/germany/hessen.html) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) – © OpenStreetMap-Mitwirkende |
| Gelände | Digitales Geländemodell **DGM1** (1 m Raster), Hessische Verwaltung für Bodenmanagement und Geoinformation (HVBG) | offene Geobasisdaten, Nutzung ohne Einschränkung (§ 18 HVGG) |
| Gebäude mit Dachformen | 3D-Gebäudemodelle **LoD2** (CityGML), HVBG | wie oben |
| Verkehrszeichen-Grafiken | Wikimedia Commons, Vektorfassungen der amtlichen Zeichen (StVO / VzKat) | gemeinfrei als amtliche Werke (§ 5 Abs. 1 UrhG) |
| Luftbilder unter der Karte (nur auf Wunsch, live) | Digitale Orthophotos **DOP20** (20 cm), HVBG, als WMS | wie Gelände und Gebäude: Nutzung ohne Einschränkung (§ 24 HVGG) |
| Fahrpläne der Straßenbahnen und RegioTrams | [gtfs.de](https://gtfs.de) – GTFS für Deutschland, aus den bundesweiten Sollfahrplandaten von [DELFI e.V.](https://www.delfi.de) (siehe [unten](#fahrpläne-der-straßenbahnen-und-regiotrams)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) – „gtfs.de, Daten bereitgestellt von DELFI e.V.“ |

Die Karte umfasst das Gebiet, für das Gelände und Gebäude geladen wurden (siehe unten): **Nordhessen** –
die kreisfreie Stadt Kassel und die Landkreise Kassel, Schwalm-Eder, Werra-Meißner, Waldeck-Frankenberg und
Hersfeld-Rotenburg, rund 6 900 km² in 29 268 Kacheln von 500 m, zusammen knapp 900 MB. Sie endet an der
Grenze des Gebiets (im Norden und Osten ist das die Landesgrenze); ein Rechteck ist sie nicht. Mehr passt
nicht: Mit dem Landkreis Fulda wäre das Gigabyte überschritten, das eine Seite auf GitHub Pages groß sein
darf.

### Warum keine Street-View- oder Satellitenbilder kommerzieller Anbieter?

Werkzeuge wie *streetview-downloader*, *pano-fetcher* oder *SAS.Planet* laden Bilder kommerzieller Anbieter
(Google, Bing, Yandex …). Deren Nutzungsbedingungen verbieten es, daraus Kartendaten abzuleiten oder die
Bilder weiterzugeben – in einem freien Projekt, dessen Daten jeder weiterverwenden dürfen soll, haben sie
deshalb nichts verloren. Für den Blick von oben gibt es etwas Besseres als Satellitenbilder: die amtlichen
**Luftbilder** des Landes Hessen (20 cm je Bildpunkt), die jeder frei nutzen darf. Die große Karte im Spiel
(Taste `M`) legt sie auf Wunsch unter das Straßennetz – sie werden dann live vom Server der
Landesvermessung geladen und passen genau, weil der Dienst im Koordinatensystem der Karte antwortet
(`src/reality/aerial.ts`). Wer lieber Google Maps oder Google Earth sieht, öffnet dieselbe Stelle von der
Realansicht aus mit einem Klick im Browser. *CoMaps* dagegen zeigt OpenStreetMap-Daten: Das ist genau die Quelle, die hier
verwendet wird. Dazu kommen die amtlichen, frei nutzbaren Geodaten des Landes Hessen, die genauer sind als
jedes Straßenfoto (Höhen auf Dezimeter, echte Dachformen).

**Ansehen ist etwas anderes als Ableiten und Weitergeben.** Deshalb gibt es im Spiel die *Realansicht*
(Taste `F`): Sie zeigt echte Straßenfotos der aktuellen Stelle – live aus den frei lizenzierten Diensten
[Panoramax](https://panoramax.fr), [KartaView](https://kartaview.org) und
[Mapillary](https://www.mapillary.com) (CC BY-SA 4.0) oder aus eigenen Dateien, auch aus Panoramen, die man
sich mit einem Street-View-Downloader gespeichert hat. Solche Bilder bleiben auf dem eigenen Gerät und
werden vom Projekt weder gespeichert noch weitergegeben; siehe [public/panos/README.md](../public/panos/README.md).

Die freien Straßenfotos eignen sich außerdem, um Schilderstandorte zu prüfen und fehlende Schilder in
OpenStreetMap nachzutragen – Mapillary und Panoramax erlauben das ausdrücklich. Nach dem nächsten Kartenlauf
stehen sie dann auch im Simulator.

## Was aus den Daten abgeleitet wird

**Direkt aus OSM übernommen** (wenn erfasst): Ampeln und ihre Haltlinien (`highway=traffic_signals` mit
`direction`), Stopp- und Vorfahrt-gewähren-Schilder (`highway=stop` / `give_way`), Tempolimits
(`maxspeed`, auch richtungsbezogen), Tempo-30-Zonen (`source:maxspeed` / `zone:maxspeed`),
verkehrsberuhigte Bereiche (`highway=living_street`), Einbahnstraßen, Fahrstreifen und Abbiegespuren
(`lanes`, `turn:lanes`), Abbiegeverbote (Relationen), Kreisverkehre, Fußgängerüberwege und Fußgängerampeln,
Bahnübergänge, Ortstafeln (`traffic_sign=city_limit`), Zufahrtsbeschränkungen, Gehwege, Beleuchtung.

**Nach deutschem Recht ergänzt**, wo OSM schweigt – so, wie die Straßen in aller Regel auch beschildert sind:

- Gleichrangige Straßen in Wohngebieten und Tempo-30-Zonen: **rechts vor links** (§ 8 Abs. 1 StVO), keine
  Schilder.
- Höherrangige Straße trifft auf niederrangige: Hauptstraße ist Vorfahrtstraße (Zeichen 306 bzw. 301),
  Nebenstraße erhält Zeichen 205.
- Grundstückszufahrten, Parkplätze, Feldwege und verkehrsberuhigte Bereiche: wartepflichtig nach § 10 StVO.
- Kreisverkehr: Zeichen 215 mit 205 an jeder Zufahrt.
- Einfädeln auf die Autobahn: Vorfahrt des durchgehenden Verkehrs (§ 18 Abs. 3 StVO).
- Tempolimit ohne Angabe: 50 km/h innerorts, 100 km/h außerorts, Autobahn ohne Limit; Schrittgeschwindigkeit
  im verkehrsberuhigten Bereich. „Innerorts“ ergibt sich aus OSM-Angaben und den bebauten Flächen.
- Ampelphasen: Festzeitprogramme mit deutscher Signalfolge (Grün – Gelb – Rot – Rot/Gelb); die echten
  Programme sind nicht öffentlich.

**Schienen:** Straßenbahn-, Stadtbahn- und Eisenbahngleise (`railway=tram` / `light_rail` / `rail`, ohne
Tunnel, Abstell- und Nebengleise) werden zusätzlich als befahrbares Netz ausgegeben: Gleisstücke mit ihren
Verbindungen an Weichen und die Haltestellen (`railway=tram_stop`, `halt`, `station`,
`public_transport=stop_position`). Darauf fahren im Spiel Straßenbahnen und Züge, sobald Gleise in der Nähe
sind – auf zweigleisigen Strecken rechts, mit Halt an den Haltestellen. Ihre Linien kommen aus
`lines.json.gz`, ihre Fahrpläne aus `timetable.json.gz` (beide unten); die Signale der Straßenbahn stellt das
Spiel selbst an Kreuzungen mit Ampel und vor Weichen auf.

**Übungsplatz für den Lkw:** Die Karte merkt sich ein möglichst ebenes, freies Feld (150 m × 66 m, ohne
Straßen, Gebäude, Wald und Wasser) in der Nähe des ersten Startpunkts. Dort legt das Spiel für die
Grundfahraufgaben der Klasse CE Asphalt, Linien, Kegel und eine Rampe über das Gelände – nur während einer
solchen Fahrstunde; an der Karte selbst wird dafür nichts verändert, in Wirklichkeit ist dort ein Acker.

Das bedeutet: Lage und Art der *erfassten* Regelung stimmen mit der Wirklichkeit überein; ergänzte Schilder
stehen an plausibler Stelle, können im Einzelfall aber von der Örtlichkeit abweichen. Wer eine Abweichung
findet, trägt sie am besten in OpenStreetMap ein – nach dem nächsten Kartenlauf stimmt es dann auch hier.

## Die Karte liegt nicht im Repository

Die Karte ist knapp ein Gigabyte groß. Im Git-Verlauf würde jeder Neubau dieses Gigabyte für immer
hinzufügen; sie liegt deshalb als tar-Archiv an einem **Release** des Projekts – in Stücken von 100 MB
(`map.tar.00`, `map.tar.01`, …), weil eine Datei von einem Gigabyte beim Hochladen nicht immer in einem
Zug ankommt. Welches Release zum Stand des Codes gehört, steht in der Datei
[`map.release`](../map.release).

```bash
npm run map:fetch     # lädt die Stücke des in map.release genannten Release und entpackt sie nach public/map (curl, tar)
```

Dasselbe macht der Arbeitsablauf, der die Seite veröffentlicht (`.github/workflows/pages.yml`). Wer die
Karte selbst gebaut hat, packt und veröffentlicht sie so:

```bash
npm run map:pack                                             # → data/work/map.tar.00, .01, …
gh release create karte-JJJJ-MM-TT --draft --title "Karte JJJJ-MM-TT" --notes "…"
for f in data/work/map.tar.*; do gh release upload karte-JJJJ-MM-TT "$f"; done   # bricht ein Stück ab: dieses noch einmal (--clobber)
gh release edit karte-JJJJ-MM-TT --draft=false
echo karte-JJJJ-MM-TT > map.release                          # und diese Änderung einchecken
```

Eine Karte in einer Datei (`map.tar`) wird von `npm run map:fetch` genauso gelesen. Eine Webseite kann die
Dateien eines Release nicht selbst laden (der Server schickt dafür keine Freigabe mit, „CORS“) – die Karte
muss deshalb mit der Seite ausgeliefert werden, und die darf bei GitHub Pages höchstens 1 GB groß sein.

## Karte neu bauen

Benötigt Node.js ≥ 24, Python 3 mit `numpy` und `Pillow`, `curl` – und Geduld: Für ganz Nordhessen werden
rund 25 GB Geländedaten geladen (und gleich wieder gelöscht, sobald sie verkleinert sind); auf der Platte
bleiben etwa 2 GB Arbeitsdaten, 8 GB Arbeitsspeicher reichen.

```bash
# 1. OpenStreetMap-Auszug Hessen (ca. 350 MB)
mkdir -p data/raw/osm
curl -L -o data/raw/osm/hessen-latest.osm.pbf \
  https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf

# 2. Gelände (DGM1) und Gebäude (LoD2) der gewünschten Kreise aus dem Downloadcenter der HVBG –
#    Gemeinde für Gemeinde laden, verkleinern, Archiv löschen (wiederholbar: Vorhandenes wird übersprungen)
python3 -I tools/fetch-geodata.py --list
python3 -I tools/fetch-geodata.py --district "Kreisfreie Stadt Kassel" --district "Landkreis Kassel" \
  --district "Schwalm-Eder-Kreis" --district "Werra-Meißner-Kreis" \
  --district "Landkreis Waldeck-Frankenberg" --district "Landkreis Hersfeld-Rotenburg"

# 3. Pipeline
npm run map:extract   # schneidet das Gebiet, für das Gelände vorliegt, in Blöcken aus dem PBF
npm run map:build     # Straßennetz des ganzen Gebiets, dann die Kacheln Block für Block (mehrere zugleich)
npm run map:addresses # Adressliste (Hausnummern aus OSM) für „Start an einer Adresse“
npm run map:stops     # Haltestellen (Namen, Masten, Bahnsteige), Namen und Bahnsteigseite der Halte an den Gleisen,
                      # Oberleitung; die Flugplätze mit Bahnen, Rollwegen und Vorfeldern
npm run map:lines     # die Linien der Straßenbahnen und RegioTrams (Weg über die Gleise, Halte)
npm run map:buslines  # die Buslinien (Weg über die Straßen, Halte, wo die Linie zurück beginnt) – nach map:build und map:stops
npm run map:far       # die Fernsicht: Gelände, Bodenbedeckung und Gebäudehöhen alle 100 m (aus den Kacheln)
npm run map:timetable # die Fahrpläne der Straßenbahnen und RegioTrams (GTFS von gtfs.de, lädt rund 280 MB)
npm run map:check     # prüft: Im gebauten Ergebnis steht nichts in einem Fahrstreifen
```

**Das Gebiet ist, wofür Gelände geladen wurde** – kein Rechteck, keine Liste im Code. Wer nur seinen
Landkreis will, lädt nur den. Mit `MAP_OUT=public/map.neu` (für `map:build` und `map:addresses`) entsteht
die Karte in einem anderen Ordner und kann am Ende in einem Zug gegen `public/map` getauscht werden;
`node tools/build-map.ts --resume` baut nach einer Unterbrechung nur die Blöcke, die noch fehlen.

### Was wo liegt

| Schritt | Ergebnis |
| --- | --- |
| `tools/fetch-geodata.py` | `data/work/dgm2/<E km>_<N km>.dgm`: das Gelände in 1-km-Kacheln auf 2-m-Raster (Mittel aus 2 × 2 Zellen des DGM1), Höhen in 2-cm-Schritten, als Differenz zu den Nachbarzellen gepackt – etwa 120 kB je km² statt 2,3 MB. `data/work/lod2/<Gemeinde>/…`: die Gebäude, in Quadrate von 2 km sortiert |
| `tools/osm-extract.ts` | `data/work/osm/b_<bx>_<bz>.json.gz`: alles aus OSM je Block von 8 km (mit Rand); `roads.json.gz`: Straßen, Wege und Gleise des ganzen Gebiets; `built.bin`: bebaute Flächen im 10-m-Raster; `region.json`: das Gebiet, für das geschnitten wurde |
| `tools/build-graph.ts` | das Straßennetz des ganzen Gebiets: `public/map/w/<cx>_<cz>.json.gz` (in Stücken von 4 km, wie das Spiel es lädt), `net.bin.gz` (jede Straße in wenigen Zahlen: für Routen, Rundfahrten und die große Karte), `rails.json.gz` (Gleise); dazu je Block, was der Kachelbau braucht (`data/work/graph`) |
| `tools/build-tiles.ts` | `public/map/tiles/<ix>_<iz>.fsb`: die Kacheln eines Blocks |
| `tools/build-map.ts` | ruft die beiden vorigen auf und schreibt `public/map/map.json`: Ortsnamen, Startpunkte, Übungsplatz, welche Kacheln und Netzstücke es gibt |
| `tools/build-stops.ts` | `stops.json.gz`: jede Haltestelle von Bus und Bahn mit Namen und Gemeinde, ihren Masten (Wartehalle, Bank, Anzeiger) und Bahnsteigen; ergänzt in `rails.json.gz` die Namen der Halte, die Seite des Bahnsteigs und die Oberleitung; `air.json.gz`: die Flugplätze mit Start- und Landebahnen, Rollwegen und Vorfeldern |
| `tools/build-lines.ts` | `lines.json.gz`: die Linien der Straßenbahnen und RegioTrams aus den Routen-Relationen von OSM – ihr Weg über die Gleisstücke und ihre Halte in der Reihenfolge (liest nur, was es braucht, aus dem PBF) |
| `tools/build-buslines.ts` | `buslines.json.gz`: die Buslinien aus den Routen-Relationen von OSM – ihr Weg über die Straßen der Karte, ihre Halte (als Nummern in `stops.json.gz`) und wo an ihrem Ende die Linie zurück beginnt (siehe [unten](#buslinien), rund 200 kB) |
| `tools/build-far.ts` | `far.bin.gz`: die Fernsicht – Gelände, Bodenbedeckung und Gebäudehöhen des ganzen Gebiets alle 100 m, aus den Kacheln (rund 2 MB) |
| `tools/build-timetable.ts` | `timetable.json.gz`: die Fahrpläne der Linien aus `lines.json.gz` – je Linie die Fahrtverläufe (Halte, Sekunden dazwischen) und ihre Abfahrten an Werktagen, Samstagen und Sonn- und Feiertagen, aus einem GTFS-Feed (rund 13 kB) |

### Stufen

1. **Straßengraph** (`mapgen/roads.ts`): Wege → Knoten/Kanten, Attribute aus Tags, Abschneiden am Rand der
   Höhendaten, Ausrunden von Knicken.
2. **Höhen** (`mapgen/elevation.ts`): Geländehöhe je Stützpunkt, gemeinsame Glättung des ganzen Netzes;
   Brücken werden zwischen ihren Rampen frei gespannt, Unterführungen bei Bedarf abgesenkt.
3. **Vorfahrt** (`mapgen/control.ts`): Ampelanlagen und Phasen, Rollen jeder Zufahrt, Überwege, Abbiegeverbote.
4. **Kreuzungsgeometrie** (`src/world/world.ts`): Ausrundungen, Kreuzungsflächen, Bordsteinlinien – derselbe
   Code liefert später die Fahrbahnoberfläche für die Physik.
5. **Schienen, Startpunkte** (`mapgen/rails.ts`, `mapgen/objects.ts`): das Gleisnetz für Straßenbahnen und
   Züge; je Ort ein öffentlicher Parkplatz als Startpunkt, sofern von dort das übrige Netz erreichbar ist.
6. **Netz für Routen** (`src/world/routegraph.ts`, `netfile.ts`): aus den Fahrstreifen und den Wegen über
   die Kreuzungen (Block für Block gebildet), welche Straße in welche abbiegen darf.

Bis hierher für das ganze Gebiet auf einmal; ab hier **Block für Block** (8 km, mit einem Rand von einer
Kachel, damit an den Blockgrenzen von beiden Seiten dasselbe herauskommt):

7. **Bodenbedeckung** (`mapgen/cover.ts`): OSM-Flächen als 2-m-Raster (Wiese, Acker, Wald, Wohngebiet …).
8. **Gelände** (`mapgen/terrain.ts`): 5-m-Raster, entlang der Straßen auf Fahrbahnniveau angeglichen.
9. **Netze** (`mapgen/roadmesh.ts`, `buildings.ts`, `objects.ts`, `signs.ts`): Fahrbahnen, Markierungen,
   Gehwege, Brücken, Gebäude, Schilder, Bäume, Laternen, Leitplanken, Gleise.
10. **Fahrstreifen freiräumen** (`src/sim/clearlanes.ts`): siehe unten.
11. **Kacheln**: 500-m-Kacheln, gzip. Damit möglichst viel Land in das Gigabyte passt, das GitHub Pages
    fasst, steht in einer Kachel nichts, was sich beim Laden ausrechnen lässt (`src/world/tilefmt.ts`):
    - Eckpunkte, Dreiecke und Höhen sind als Schritte zum Vorgänger gespeichert (das Gelände als das, was
      die Nachbarpunkte links und oben nicht vorhersagen), niedrige und hohe Bytes getrennt – das halbiert
      die Größe;
    - das Gelände in Schritten von 4 cm – die Fahrbahn hat ihre eigenen Höhen, der Boden liegt 25 cm
      darunter;
    - von einem Baum nur der Ort (auf 10 cm), Höhe und Art: auf welcher Höhe er steht, sagt das Gelände;
    - von den Flächen der Gebäude nur die Ecken und Farben: Was die Fassade braucht (wo auf der Wand ein
      Punkt liegt, wie lang und wie hoch die Wand ist, damit Fenster in Reihen und Spalten passen), folgt
      aus den Ecken. Der Kartenbau prüft das Fläche für Fläche und speichert die Werte nur dort, wo die
      Regel sie nicht auf 4 cm trifft – bei etwa einer von 200 Ecken (`src/world/facade.ts`).

### Nichts steht im Fahrstreifen

Die Karte entsteht aus Quellen, die nichts voneinander wissen. Die Leitplanke der einen Richtungsfahrbahn
kann im Fahrstreifen der anderen landen, ein Schilderpfosten auf einer Verkehrsinsel, für die das
Straßenmodell keinen Platz hat, die Ecke eines Hauses in einer Gasse, die schmaler ist als ihre
Fahrstreifen. Ein Mensch fährt darum herum oder bleibt davor stehen; der Fahrer der Vorführfahrt bleibt
stehen. Deshalb gilt beim Kartenbau eine einfache Regel: **Was näher an der Mitte eines Fahrstreifens (oder
eines Wegs über eine Kreuzung) steht, als ein Fahrzeug breit ist, kommt dort weg.** Pfosten werden neben
den Fahrstreifen gerückt (oder entfallen, wenn kein Platz ist), Laternen und Baumstämme entfallen, Mauern,
Hecken, Leitplanken und Brückengeländer bekommen dort eine Lücke, und von Gebäudeumrissen zählen die
Seiten nicht als Hindernis, die in den Fahrstreifen ragen (das Gebäude selbst bleibt sichtbar).
`npm run map:check` fährt zur Kontrolle einen wagenbreiten Kreis jeden Fahrstreifen entlang.

### Andere oder weitere Gemeinden?

Weitere hessische Kreise: mit `tools/fetch-geodata.py` laden und die Pipeline laufen lassen. Die Grenze
setzt GitHub Pages: Eine Seite darf 1 GB groß sein. Für andere Bundesländer müssen der Abruf und die Leser
für Höhenmodell und Gebäude an das jeweilige Lieferformat angepasst werden (viele Länder bieten ebenfalls
offene DGM1/LoD2-Daten).

## Fahrpläne der Straßenbahnen und RegioTrams

Welchen Weg eine Linie fährt, steht in `lines.json.gz`; wann ihre Bahnen fahren, in `timetable.json.gz`. Das
entsteht aus einem **GTFS-Feed**, dem Format, in dem der öffentliche Verkehr seine Fahrpläne veröffentlicht:

```bash
npm run map:timetable                                                   # lädt die aktuellen Feeds von gtfs.de
node --max-old-space-size=1536 tools/build-timetable.ts feed.zip …      # oder vorhandene Feeds (Zip oder Ordner)
```

- **Quelle:** [gtfs.de](https://gtfs.de) – „GTFS für Deutschland“, täglich aus dem bundesweiten
  Sollfahrplan-Datensatz von [DELFI e.V.](https://www.delfi.de) erzeugt, jeweils für die nächsten 30 Tage. Die
  Straßenbahnen der KVG stehen im Feed *Nahverkehr* (`nv_free`, rund 270 MB), die RegioTrams RT1, RT4 und RT5
  im Feed *Regionalverkehr* (`rv_free`, rund 11 MB); das Werkzeug lädt beide nach `data/raw/gtfs/`, jeden in
  einen eigenen Ordner mit dem Datum des Feeds, und nimmt beim nächsten Lauf die vorhandene Datei, solange der
  Server nichts Neueres hat (ist er nicht zu erreichen, die neueste vorhandene). Ältere Fassungen löscht es,
  sobald eine neuere geladen ist, eine geladene Datei über 300 MB nach dem Lauf.
- **Lizenz:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Die Namensnennung steht in der Datei
  (`attribution`) und gehört überall hin, wo das Spiel die Zeiten zeigt: „Fahrplandaten: gtfs.de – GTFS für
  Deutschland (https://gtfs.de), Daten bereitgestellt von DELFI e.V. (https://www.delfi.de), mit Beiträgen von:
  OpenStreetMap contributors, Lizenz CC BY 4.0 (…) – für das Spiel auf die Straßenbahnen und RegioTrams in Kassel
  gekürzt und umgerechnet“ (wen der Feed in seiner `attributions.txt` nennt, nennt sie mit).
- **Nichts wird entpackt:** `stop_times.txt` ist für ganz Deutschland 2 GB groß. Das Werkzeug liest sie mit
  `unzip -p` direkt aus dem Zip und macht nur aus den Zeilen der gesuchten Fahrten Text; ein Lauf dauert auf
  einem langsamen Rechner ein bis zwei Minuten und braucht wenig Speicher.
- **Welche Fahrten:** die der KVG, der RegioTram und des NVV (`GTFS_AGENCY`, ein regulärer Ausdruck), die auf
  Schienen fahren und deren Liniennummer die Karte hat. Jede Fahrt kommt zu der Linie der Karte, deren Halte
  sie in derselben Reihenfolge am meisten anfährt; Anfang und Ende zählen extra („Wolfsanger → Königsplatz“
  ist nicht „Wolfsanger → Mattenberg“).
- **Namen:** GTFS schreibt „Kassel Königsplatz“, „Baunatal-Großenritte Bahnhof“, „Kassel Halitplatz/Philipp-
  Scheidemann-Haus“, die Karte „Königsplatz“, „Großenritte Bahnhof“, „Halitplatz“. Der Abgleich schreibt Umlaute
  und Abkürzungen aus, nimmt den Ort vorn weg (bei einem der beiden Namen: „Vellmar Stadtmitte“ ist nicht die
  in Hessisch Lichtenau), lässt einen der Namen um einen Schrägstrich oder einen Ortsteil davor gelten und
  verzeiht kleine Schreibunterschiede („Mattenbergsiedlung“, „Mattenberg Siedlung“). Was nicht ganz gleich
  ist, was die Linie der Karte nicht hat und was gar nicht passt, zählt der Lauf am Ende auf.
- **Eine Woche:** Gespeichert wird je Linie jeder Fahrtverlauf (die Halte und die Sekunden dazwischen) mit
  seinen Abfahrten an Werktagen, Samstagen und Sonn- und Feiertagen – aus einer gewöhnlichen Woche des Feeds:
  ganz im Gültigkeitszeitraum, ohne Feiertag, und die, deren Tage am meisten anderen Wochen gleichen (nicht
  die mit den meisten Fahrten: Eine Baustelle, die eine Linie teilt, verdoppelt deren Fahrten, die
  Schulferien lassen eine weg). Die Werktage kommen von ihrem Mittwoch; `GTFS_WEEK=JJJJ-MM-TT` (ein Montag)
  wählt eine andere Woche. Fahrten nach Mitternacht behalten wie in GTFS Zeiten über 24 Uhr, das Spiel
  (`src/sim/timetable.ts`) sieht deshalb den Vortag mit an. Nächtliche Zusatzfahrten, die es nur in der Nacht
  zum Samstag gibt, fehlen damit.
- **Nur die Halte der Karte:** Ein Fahrtverlauf enthält nur die Halte, die die Linie auf der Karte hat. Fährt
  die Bahn darüber hinaus (die RegioTram nach Hümme, Wolfhagen oder Melsungen) oder kommt sie von weiter her,
  ist das vermerkt; ihr Ziel steht dabei, wie die Anzeiger es schreiben („Hümme“, „Melsungen“).
- **Andere Feeds:** Jeder GTFS-Feed lässt sich angeben; `GTFS_ATTRIBUTION` setzt dann die Namensnennung. Der
  kleinste, der alles enthält, sind die „Soll-Fahrplandaten NVV“ auf
  [opendata-oepnv.de](https://www.opendata-oepnv.de) (RegioTram, Tram und Bus, 4 MB, CC BY 4.0) – sie werden
  aber nur von Zeit zu Zeit neu hochgeladen, jedes Mal unter einer anderen Adresse, und der letzte galt nur bis
  zum 31. 10. 2026. Deshalb lädt das Werkzeug von sich aus gtfs.de.

## Buslinien

`npm run map:buslines` (`tools/build-buslines.ts`) macht aus jeder Routen-Relation von OSM (`route=bus`,
`route=trolleybus`), die eine Straße der Karte berührt, eine Linie in `buslines.json.gz`: Nummer, Name, Start,
Ziel, Betreiber und Farbe, den Weg als Folge von Straßen der Karte mit ihrer Fahrtrichtung und die Halte mit
ihrer Stelle an diesem Weg. Die Busse im Verkehr fahren damit ihre Linie (`src/sim/traffic.ts`).

- **Was gelesen wird:** die Stücke des Straßennetzes (`w/*.json.gz` – jede Straße nennt den OSM-Weg, aus dem
  sie entstand, jede Kreuzung ihren OSM-Knoten), `net.bin.gz` (welche Straße in welche abbiegen darf),
  `stops.json.gz` und aus dem PBF in drei Durchgängen nur die Relationen, ihre Wege und die nötigen Knoten (rund
  drei Minuten, unter 400 MB Speicher).
- **Zuordnung über die IDs, nicht über die Lage:** Die Wege einer Relation werden Knoten für Knoten verkettet –
  ein Kreisverkehr nur bis zur Ausfahrt, ein nicht geteilter Weg nur bis zur Abzweigung –, und zwischen je zwei
  Kreuzungen wird die Straße dieses OSM-Wegs nachgeschlagen. Eine Straße heißt im Spiel nach ihrer Nummer in der
  ganzen Karte (dieselbe in `net.bin.gz` und in jedem Stück des Netzes), mit Richtung als „Weg“ (Straße × 2 +
  Richtung) wie im Routenplaner (`src/world/routegraph.ts`). Diese Nummern gelten nur für einen Bau des
  Straßennetzes: Die Datei nennt ihn (`map`, das `generated` aus `map.json`), und das Spiel nimmt sie nur zu
  dieser Karte – nach `map:build` und `map:stops` muss also auch `map:buslines` laufen.
- **Lücken:** Wo die Karte für ein Stück keine Straße hat (`highway=busway`, eine Busspur gegen die
  Einbahnstraße, ein Weg, der in der Relation fehlt) oder eine Abbiegung nicht erlaubt (Abbiegeverbote gelten in
  der Karte auch für Busse: `except=bus` wird beim Kartenbau nicht ausgewertet; Wenden mitten auf der Straße gibt
  es nur in Sackgassen), sucht eine kurze Suche über die erlaubten Abbiegungen den Weg herum. Was sie nicht
  schließt, zählt der Lauf; ein Bus verliert dort seine Linie und sucht sich im Spiel den Weg zurück.
- **Am Ende der Linie:** Gesucht wird, wo die Linie zurück beginnt (dieselbe `route_master`, sonst dieselbe
  Nummer und derselbe Betreiber) – auch durch eine Wendeschleife nur für Busse, die die Karte als private Straße
  führt. Der Weg dorthin wird an die Linie angehängt (`end`, `back`).
- **Fernbusse** (`service=long_distance`, Flixbus und ähnliche) bleiben weg: Die Busse im Verkehr sind Stadt-
  und Regionalbusse.
- **Stand des Kartenbaus vom November 2026:** 4002 Bus-Relationen in Hessen, 691 berühren die Karte, 35 davon
  Fernbusse. 625 Linien (je Richtung): 411 vollständig, 214 teilweise (157 verlassen die Karte, 25 mit Lücken,
  die die Suche nicht schließt, 20 mit Halten abseits des Wegs, 6 über Busstraßen, 6 gegen eine Einbahnstraße),
  31 gar nicht (kürzer als 300 m auf der Karte oder ohne zwei verbundene Straßen); 558 fahren an ihrem Ende als
  Linie zurück weiter. 10 319 Halte; die Datei ist rund 200 kB groß.

## Koordinaten

Weltkoordinaten in Metern: `x` = Ost, `y` = Höhe über NHN (DHHN2016), `z` = Süd. Ursprung bei
E 528 000 / N 5 678 000 (ETRS89 / UTM Zone 32N, EPSG:25832), nahe der Baunataler Stadtmitte.
