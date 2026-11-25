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
| Luftbilder unter den Karten (live, abschaltbar) | Digitale Orthophotos **DOP20** (20 cm), HVBG, als WMS | wie Gelände und Gebäude: Nutzung ohne Einschränkung (§ 24 HVGG) |
| Fahrpläne der Straßenbahnen, RegioTrams und Busse | [gtfs.de](https://gtfs.de) – GTFS für Deutschland, aus den bundesweiten Sollfahrplandaten von [DELFI e.V.](https://www.delfi.de) (siehe [unten](#fahrpläne-der-straßenbahnen-und-regiotrams)) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) – „gtfs.de, Daten bereitgestellt von DELFI e.V.“ |

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
(Taste `M`), die runde Karte in der Ecke und der Bildschirm im Auto legen sie unter das Straßennetz (in den
Einstellungen abschaltbar) – sie werden dann live vom Server der
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
npm run map:timetable # die Fahrpläne der Straßenbahnen, RegioTrams und Busse (GTFS von gtfs.de, lädt rund 280 MB) – nach map:buslines
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
| `tools/build-timetable.ts` | `timetable.json.gz`: die Fahrpläne der Linien aus `lines.json.gz` und `buslines.json.gz` – je Linie die Fahrtverläufe (Halte, Sekunden dazwischen, Ziel) und ihre Abfahrten an Werktagen, Samstagen und Sonn- und Feiertagen, aus einem GTFS-Feed (rund 85 kB, davon 70 kB Busse) |

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

7. **Bodenbedeckung** (`mapgen/cover.ts`): OSM-Flächen als 2-m-Raster (Wiese, Acker, Wald, Wohngebiet …),
   gemalt in einem dreimal feineren Raster: Je Zelle steht in der Kachel (Abschnitt `cedge`, ältere Versionen
   lesen ihn nicht), wie weit ihre Mitte in ihrer Klasse liegt (bis 3 m, in Zehntelmetern); daraus zeichnet das
   Spiel die Grenzen als glatte Linien statt 2-m-Treppen (`src/render/coveredge.ts`). Trockene Becken
   (`basin=detention|infiltration`, `intermittent=yes`) sind Wiese, kein Wasser; Bäche so breit wie `width`, mindestens
   2,4 m. In `landuse=retail|commercial` ist nur befestigt, was bis 6 m um Gebäude, an Zufahrten (5 m) und
   Parkplatzgassen (8 m) liegt – der Rest Rasen.
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

### Straßenquerschnitt: Parken, Gehwege, Radwege, Mittelstreifen

Was neben den Fahrstreifen liegt, kommt aus den Tags des Wegs (`tools/mapgen/xsection.ts`; `<side>` =
`left` | `right` | `both`, in Zeichenrichtung des Wegs):

- `parking:<side>` = `lane` | `street_side` | `half_on_kerb` | `on_kerb` | `shoulder` | `no` (auch das ältere
  `parking:lane:*`), dazu `parking:<side>:orientation` = `parallel` | `diagonal` | `perpendicular`,
  `parking:<side>:width` und **`parking:<side>:markings` = `yes` | `no`** (gemalte Parkstandslinien; ohne Angabe
  nur bei `street_side`). Parkstreifen auf der Fahrbahn verbreitern sie, die Fahrstreifen bleiben frei; in die
  Parkstände stellt der Kartenbau stehende Autos (60–80 % belegt, jede Straße gleich bei jedem Lauf), nicht
  näher als 5 m an Kreuzungen und vor Zebrastreifen, nicht 15 m um Bushaltestellen, nicht vor Zufahrten.
  **`parking:<side>:occupancy` = Anteil 0–1 | `n%` | `low` (15 %) | `high` (90 %) | `none`** (eigene Erweiterung):
  so viele Parkstände sind belegt – `low`, wo nur ab und zu ein Auto steht, keine Reihe.
- `sidewalk[:<side>]`, `sidewalk:<side>:width`, `kerb[:<side>]` = `raised` | `lowered` | `flush`.
- **`verge:<side>` = `grass` | Breite in m** (eigene Erweiterung): Grünstreifen zwischen Bordstein und Gehweg.
- `cycleway[:<side>]` = `lane` (Radfahrstreifen bzw. mit `cycleway:<side>:lane=advisory` Schutzstreifen,
  mit Fahrradsymbolen; rot bei `cycleway:<side>:surface:colour=red`) | `track` (eigener Weg zwischen Bordstein
  und Gehweg).
- **`median:contents` = `grass` | `parking` | `hedge` | `trees` | `paving_stones`**, mit `;` kombinierbar (eigene
  Erweiterung): an einer Richtungsfahrbahn, was links von ihr bis zur Gegenfahrbahn liegt; `paving_stones;trees`
  ist ein gepflasterter Streifen mit jungen Bäumen.
- **`verge:<side>`** nimmt auch `paving_stones` (gepflastert statt Gras) und `;trees` (junge Bäume darin, alle 10 m),
  die Breite dann mit `verge:<side>:width`.
- **`gutter[:<side>]` = `no` | `yes` | Breite in m** (eigene Erweiterung): die gepflasterte Rinne zwischen Asphalt
  und Bordstein. Ohne Angabe 0,4 m innerorts, wo ein hoher Bordstein ist (nicht vor Parkbuchten mit eigenem
  Pflaster); auch um die Ecken der Kreuzungen (dort die schmalste der Straßen, keine, wenn eine `no` sagt).
- **`lane_markings:edge` = `yes` | `no` | `left` | `right` | `both`** (eigene Erweiterung): Randlinien je Seite. Ohne
  Angabe wie bisher: auf markierten Straßen außerorts und auf Autobahnen.
- **`parking:<side>:trees` = alle n m | `yes` (20 m)** (eigene Erweiterung): statt eines Parkstands eine
  Baumscheibe mit Bordstein und Baum. Ebenso überall, wo OSM einen `natural=tree` im Parkstreifen hat.
- **`frontage:<side>` = `hedge` | `fence` | `wall` | `lawn`**, `frontage:<side>:height`,
  **`frontage:<side>:offset`** (eigene Erweiterung; Höhe ohne Angabe: Hecke 1,8 m wie eine Gartenhecke, Zaun
  1,2 m, Mauer 1,0 m; Abstand in m hinter dem Gehweg, ohne Angabe 0,3 m – wo kein Gehweg ist, 1,0 m hinter dem
  Bordstein, denn Vorgärten enden nicht am Asphalt): wo OSM nichts erfasst hat; Lücken an Einmündungen, erfassten
  Zufahrten, Gebäuden und auf befestigten Flächen (Hofeinfahrten, Vorplätze als Fläche erfasst). Gilt für den
  ganzen Weg (oder ein Stück mit `split`): wo Hecke, Mauer und Einfahrt wechseln, besser nur die Stücke taggen.

Ist der Gehweg als eigener Weg erfasst (`footway=sidewalk`, die Straße mit `sidewalk=separate` oder ohne
Angabe), reicht der Gehweg der Straße bis zu diesem Weg, mit Grünstreifen dazwischen – ein Gehweg, nicht zwei –,
im Belag dieses Wegs (`surface`, bei Radwegen ohne Angabe Asphalt), wenn die Straße keinen sagt. Ebenso werden
Fußweg-, Radweg- und `path`-Brücken (`bridge=*`) neben einer Straßenbrücke deren erhöhte Gehwege, ohne Grünstreifen;
an einem Gehweg steht auf einer Brücke ein offenes Geländer auf einem niedrigen Betonrand statt der geschlossenen
Brüstung (die bleibt, wo die Fahrbahn bis an den Rand reicht).
Eine Breite (`width`), die weit über die Fahrstreifen hinausgeht (über 4,6 m je Streifen), legt die Fahrstreifen in
üblicher Breite (3,25–3,5 m) in die Mitte und Asphalt zu beiden Seiten – nicht mehr verworfen.

**Eigene Wege** (`tools/mapgen/paths.ts`): `highway=footway` | `cycleway` | `path` | `pedestrian` | `bridleway`
liegen als Streifen ihrer Breite auf dem Gelände (`width`, sonst Fußweg 2,0 m, Radweg und gemeinsamer Geh- und
Radweg 2,5 m, sonstiger `path` 1,5 m, Fußgängerzone 4,0 m), im Belag nach `surface` (asphalt, paving_stones,
sett, concrete, compacted/fine_gravel, gravel, ground …; ohne Angabe Pflaster im Ort, Asphalt für Radwege,
Splitt außerhalb). Weggelassen wird, was schon im Straßenmodell liegt (die Mitte auf Fahrbahn, Gehweg oder
Kreuzung, bei `footway=sidewalk` jeder Teil), Brücken, Tunnel, Treppen, Flächen, Gras und Holz. Auf einem Weg
wächst kein gestreuter Baum. Überwege: `crossing=zebra`, `crossing:markings=zebra` und `crossing=marked` ohne
andere Markierung werden Zebrastreifen; `crossing=marked` mit `crossing:markings=dashes|lines|…` nicht mehr.

**Verkehrsinseln** (`tools/mapgen/islands.ts`): erfasste Flächen (`area:highway=traffic_island`, geschlossene
`traffic_calming=island`), Querungshilfen auf zweistreifigen Straßen (`crossing:island=yes` 5 m, Knoten mit
`traffic_calming=island` 8 m lang) und die Insel, wo sich eine Straße in zwei Richtungsfahrbahnen teilt, die sich
im selben Knoten treffen (bis 80 m davon; längere sind Mittelstreifen; nur wo sie irgendwo mindestens 2 m von
Bordstein zu Bordstein auseinandergehen, und nicht, wo zusammengelegte Fahrbahnen – `merge` – auseinandergehen).
Mit Bordstein, 12 cm hoch, Belag nach
**`island:surface` = `grass` | `plants` | `paving_stones` | `cobblestone` | `asphalt`** (eigene Erweiterung, an der
Fläche, dem Knoten oder der Fahrbahn; Standard Pflaster). Wo der Verkehr auf beiden Seiten vorbeifährt, steht an
der Spitze Zeichen 222 zum Verkehr hin. Die Fahrstreifen werden für eine Insel nicht verbreitert: Sie bleibt
1,1 m von der Mitte jedes Fahrstreifens weg (ihre Ecken werden zurückgeschoben, eine zu enge entfällt).

**Mauern, Hecken, Zäune aus OSM** (`tools/mapgen/objects.ts`): in ihrer Höhe `height`, sonst wie bisher. Zäune
(`barrier=fence`) erscheinen jetzt auch – außer Draht-, Stacheldraht- und Elektrozäunen; ohne `fence_type` nur in
bebautem Land (Gärten, Höfe), nicht um Weiden.

**Korrekturen vor Ort** (`tools/mapgen/observed-roads.json`): je OSM-Weg Tags, die über die erfassten gelegt
werden (`null` löscht) – für alle Teile des Kartenbaus, die OSM lesen (`OsmData.load`, `readPbf`). Danach
Straßennetz und Kacheln neu bauen. Außerdem:

- **Lage** (wo OSM neben der Straße der Luftbilder liegt): `"ways": {"<id>": {"shift": [dx, dz]}}` verschiebt alle
  Knoten des Wegs um dx Meter nach Osten, dz nach Süden; `"nodes": {"<id>": [dx, dz]}` einen Knoten (eine
  Kreuzung, ein Knick) – das geht den Verschiebungen seiner Wege vor. Ein Knoten zweier verschobener Wege rückt um
  das Mittel ihrer Verschiebungen. Die Auszüge behalten die erfasste Lage; verschoben wird beim Lesen (`OsmData.load`
  für Straßennetz, Kacheln, Haltestellen, Adressen; `readPbf` für Schilder, Linien, Buslinien, Dienste – die Knoten
  der verschobenen Wege sucht es einmal im PBF und merkt sie sich daneben in `<pbf>.shift-refs.json`).
- **Ergänzen**: `"areas": [{"id": "obs-1", "tags": {"amenity": "parking"}, "pts": [[x, z], …]}]` – Flächen in
  Weltmetern, wie erfasste Flächen mit diesen Tags behandelt (Parkplätze, `area:highway=…`, `landuse` mit
  `surface` …); `"newWays": [{"id": "obs-w1", "tags": {"highway": "service"}, "pts": [[x, z], …], "connect": true}]` –
  neue Wege; mit `connect` schließt jedes Ende an den nächsten Knoten eines Wegs derselben Art (Straße, Gleis …)
  innerhalb 3 m an, oder – wenn ein Wegstück mehr als 1 m näher vorbeiführt – mitten in dieses Stück (dort entsteht
  ein Knoten). Sie bekommen negative Nummern aus ihrem Namen (Wege −1e9 − n, Knoten −2e9 − …), die keiner OSM-Nummer
  begegnen und bei jedem Lauf gleich sind.
- **Entfernen**: `"remove": [<OSM-Weg-Nr.>, …]` – Wege, die es nicht gibt.
- **Teilen** (`tools/mapgen/waysplit.ts`): `"split": [{"osm": <Weg-Nr.>, "at": [x, z]}, …]` schneidet den Weg am
  nächstgelegenen Punkt (an seinem Knoten, wenn einer näher als 1 m liegt, sonst an einem neuen). Mehrere Einträge
  schneiden ihn mehrfach. Die Teile heißen `"<Nr.>:1"`, `"<Nr.>:2"` … in Zeichenrichtung des Wegs; unter `"ways"`
  bekommen sie eigene Tags (über die Tags des ganzen Wegs unter `"<Nr.>"`), `"remove": ["<Nr.>:3"]` entfernt einen
  Teil. Das Straßennetz nennt die Straßen der Teile nach dem OSM-Weg (Buslinien, Abbiegeverbote finden sie wie
  bisher). Verschieben (`shift`) gilt nur für den ganzen Weg.
- **Zusammenlegen**: `"merge": [{"id": "…", "a": [Wege der einen Richtungsfahrbahn], "b": [Wege der anderen],
  "from": [x, z], "to": [x, z], "tags": {…}}]` – zwischen den Punkten beider Fahrbahnen, die `from` und `to` am
  nächsten liegen, werden beide durch einen Weg mit Verkehr in beide Richtungen in ihrer Mitte ersetzt. Seine Tags:
  die der ersten Fahrbahn ohne `oneway`, `lanes*`, `turn:lanes*`, `median:contents`, darüber `tags` (`null`
  löscht). Ohne `width` in `tags` ist er so breit wie beide Fahrbahnen zusammen (Abstand ihrer Mittellinien plus
  je eine halbe Fahrbahn: `width` oder Fahrstreifen × 3,25 m); `"width": null` lässt die übliche Breite. Die Fahrbahnen außerhalb treffen ihn in je einem Knoten; Einmündungen und Knoten mit Tags auf der
  Strecke rücken auf ihn. Querverbindungen zwischen den Fahrbahnen besser mit `remove` entfernen. Buslinien über
  die Strecke flickt `map:buslines` mit seiner Suche.
- **Punkte**: `"points": [{"id": "…", "at": [x, z], "tags": {"traffic_calming": "table"}, "way": "<Nr.>"}]` – ein
  Knoten mit diesen Tags in der nächsten Straße (höchstens 10 m entfernt; oder im genannten Weg, auch `"<Nr.>:<n>"`),
  wo OSM eine Aufpflasterung, eine Einengung, ein Vorfahrtschild … nicht hat.

**Bauliches und Markierungen auf der Fahrbahn** (`src/world/roadfeatures.ts`, `tools/mapgen/roadextras.ts`,
`streetpaint.ts`):

- `traffic_calming=table | hump | bump | cushion` (Knoten auf der Straße, oder ein kurzer Weg ≤ 40 m, der selbst
  die Aufpflasterung ist), dazu `length` (Tisch: Plateau, Standard 4 m; Schwelle 3,7 m; Bodenwelle 0,6 m) und
  `height` (Standard 8 bzw. 6 cm): Die Fahrbahn – nicht der Gehweg – hebt sich dort an (Rampen 1,2 m), die Physik
  spürt es (`World.surfaceAt`, `EdgeJson.cm`); auf den Rampen eines Tisches Haifischzähne in den Fahrstreifen, die
  hinauffahren. Liegt sie im Kreuzungsbereich, rückt sie an dessen Rand.
- `traffic_calming=choker | chicane` (Knoten): bepflanzte Fahrbahneinengung mit Bordstein (Einengung: beide
  Seiten; Schikane: rechts, dann links; oder `side=left|right|both`), `length` (5 m), Tiefe 1,6 m
  (**`traffic_calming:depth`**). Auf einer schmalen Straße ohne Fahrstreifenmarkierung (zweistreifig) engt sie die
  Fahrbahn auf eine Spur ein – 3,2 m bleiben frei (bei einer Einengung beider Seiten zusammen), der Gegenverkehr
  wartet; auf markierten Straßen bleibt sie 1,1 m von der Mitte des äußeren Fahrstreifens. Im Beet Sträucher und ein
  junger Baum, wo sein Stamm nicht in einem Fahrstreifen stünde, sonst ein hoher Strauch (`planted=no`, `tree=no`:
  ohne); mit **`beacon=yes`** (eigener Schlüssel) eine rot-weiße Bake an der Spitze. Parkstände halten 6 m Abstand.
- **`mouth:kerb=lowered | raised`** (eigener Schlüssel, am einmündenden Weg): Einmündung über einen durchgehenden
  Gehweg – kein Bordsteinradius, abgesenkter Bord (3 cm) quer über die Mündung, der Gehweg der Hauptstraße läuft
  durch. Ohne Angabe so bei gepflasterten verkehrsberuhigten Bereichen (`living_street`, ohne `surface` gilt
  Pflaster), `service=driveway` und `service=emergency_access`.
- **`markings:give_way=yes | no`** (eigener Schlüssel): Haifischzahn-/Wartelinie (Zeichen 341) an einer
  Einmündung mit Vorfahrt achten; ohne Angabe gemalt, wo ein `highway=give_way`/`stop` auf der Straße erfasst ist
  (sonst wie bisher nur an markierten Straßen).
- **`markings:zigzag=left | right | both`** (eigener Schlüssel, Seite in Zeichenrichtung): Grenzmarkierung
  (Zeichen 299) am Bordstein über den ganzen Weg (mit `split` über ein Stück); an einer Bushaltestelle auf der Straße
  (`highway=bus_stop` mit `markings:zigzag=yes|left|right|both`) 15 m davor und danach.
- **`road_text=<Text>`** (eigener Schlüssel): Schrift auf der Fahrbahn (Ziffern, A–Z) in den Fahrstreifen in
  Zeichenrichtung, **`road_text:position`** m vom Anfang des Wegs (Standard 10, mehrere mit `;`);
  **`road_text:backward`** und **`road_text:backward:position`** (m vom Ende) für die Gegenrichtung.
- Radfahrerfurt: Wo die Radfahrstreifen einer Straße über eine Einmündung weiterlaufen, gestrichelte Ränder quer
  über die Mündung, rot gefüllt bei roten Streifen (`cycleway:<side>:surface:colour=red`). Erfasste Querungen
  (`cycleway|footway|path=crossing` mit `surface:colour=red` oder `colour=red`) werden rot, wo sie auf der Fahrbahn liegen.
- **`sidewalk:<side>:surface`** (`asphalt`, `paving_stones`, `concrete`, `sett` …) und **`sidewalk:<side>:colour`**
  (eigener Schlüssel: `grey`, `red`, `anthracite`): Belag des Gehwegs je Seite, auch um die Kreuzungsecken. Rote
  Pflaster werden im Rot der Radwege, anthrazitfarbene als dunkles Kleinpflaster gezeichnet, Asphalt wie
  Asphaltwege (nicht wie die Fahrbahn, sonst sieht der Gehweg wie ein Fahrstreifen aus) – die Materialien, die
  ältere Spielversionen kennen. Ohne Angabe: graue Platten.
- Flächen: `amenity=parking`, `highway=*` + `area=yes` usw. (auch die Flächen der Liste) im Belag nach `surface`
  (`asphalt` → Asphalt, `paving_stones|sett|concrete` → Pflaster, `gravel|compacted|ground` → Schotter/Erde,
  `grass_paver` → Gras). Kleine Grünflächen (`landuse=grass|flowerbed`, `natural=scrub|wood` unter 3000 m²) liegen
  über den befestigten Flächen um sie herum – eine bepflanzte Insel auf einem Parkplatz oder einer Tankstelle.
- Wald und Gebüsch (`landuse=forest`, `natural=wood|scrub`, auch als Fläche der Liste) reichen bis an den
  Straßenrand: eine Reihe Bäume bzw. Sträucher 1,4–2,6 m neben Fahrbahn und Gehweg, alle 5–8 m, nicht an Feld- und
  Waldwegen (`tools/mapgen/woodedge.ts`).

**Grün aus den Luftbildern** (`tools/mapgen/observed-greenery.json`, `tools/mapgen/greenery.ts`;
`OBSERVED_GREENERY=<Datei>|none`): `"trees": [{"kind": "wood"|"group"|"row", "pts": [[x, z], …], "density":
"dense"|"medium"|"sparse", "height": "small"|"medium"|"large", "leaf": "broadleaf"|"conifer"|"mixed"}]` – Flächen
mit Bäumen alle 6,5 / 9 / 13 m, Reihen alle 9 m, 6–10 / 10–16 / 15–25 m hoch; Laubbäume, außer `leaf` sagt `conifer`
(alle Nadelbäume) oder `mixed` (etwa ein Viertel); nicht auf Straßen, Wegen, Gebäuden und nicht dort, wo die
Bodenbedeckung schon Wald ist. `"hedges": [{"pts": […], "height_m": 1.6}]` – Hecken wie die beobachteten an
Gebäuden. Laubbäume zeichnet das Spiel mit Kronen, die zur Höhe passen: rund 6 m bei 7 m Höhe, 11–13 m bei 15 m,
höchstens 14 m (`src/render/props.ts`). Kahle Kronen (Spätherbst, Winter) sind hell graubraun und gleichmäßig
beleuchtet wie der Boden – keine Kugel mit dunkler Schattenseite (`src/render/season.ts`: `BARE_CROWN`, `BARE_FLAT`).

**Gebäude aus den Luftbildern** (`tools/mapgen/observed-buildings.json`, `tools/mapgen/buildings.ts`): je LoD2-Modell
außer Farben auch `"roofShape": "flat"` (das schräge Dach des Modells flach, `"flatAt"` 0 = in Traufhöhe … 1 = in
Firsthöhe) und `"roofMaterial": "green"|"flat"|"gravel"|"metal"|"tiles"` (`green`: flaches begrüntes Dach, Farbe ohne
Angabe `#5f7a4a`); `"add": [{"id": "obs-b1", "pts": [[x, z], …], "height": m, "roof": "flat"|"gable"|"hip", "wall":
"#…", "roofColour": "#…"}]` – Gebäude, die weder LoD2 noch OSM haben; `"remove": ["<LoD2-Id>" | "w<OSM-Weg>", …]`.
Innerhalb der Gemeinden mit LoD2 kommen OSM-Umrisse dazu, die kein Modell bedeckt (Neubauten, Gartenhütten).
Dächer unter 15° Neigung sind nicht mit Ziegeln gedeckt (grau bis dunkel wie Flachdächer).

Ergänzt wird nur beim Lesen der Auszüge (`OsmData.load`); `readPbf` lässt die entfernten Wege weg, ergänzt aber
nichts (was das PBF direkt liest, findet seine Dinge über OSM-Nummern und Tags). Zum Ausprobieren an zwei Blöcken, ohne `public/map` anzufassen:

```bash
MAP_OUT=/tmp/m MAP_WORK=/tmp/w GRAPH_OSM=data/work/osm/b_25_24.json.gz,data/work/osm/b_25_25.json.gz \
  GRAPH_BLOCKS=25_24,25_25 node --max-old-space-size=3072 tools/build-graph.ts
MAP_OUT=/tmp/m MAP_WORK=/tmp/w node --max-old-space-size=3072 tools/build-tiles.ts 25_24 25_25
```

### Detailgebiet: Neues nur dort, sonst die veröffentlichte Karte Byte für Byte

Alles aus dem Abschnitt davor (Querschnitte, Parken, Wege, Inseln, feinere Bodenbedeckung, Dächer, die Listen
`observed-*.json` …) gilt nur im **Detailgebiet** (`tools/mapgen/detail-region.json`: Kästen `[minX, minZ, maxX, maxZ]`
in Weltmetern, zuerst die Mitte Baunatals; `DETAIL_REGION=<Datei>|none|all`). Außerhalb schreibt der Kartenbau
dieselben Bytes wie die veröffentlichte Karte (Release `karte-2026-11-16c` mit dem Patch von 1.6.0), so dass ein Release
nur die geänderten Dateien ausliefern muss statt der ganzen Karte. Entschieden wird:

- **Straßen** als Ganzes nach dem Punkt auf halber Länge (`tools/mapgen/detailgraph.ts`): `build-graph` baut zuerst das
  ganze Netz wie damals (`roadAttrsLegacy`, ohne Korrekturen, Höhen über das ganze Netz), dann die Wege um das Gebiet
  neu – mit den Korrekturen von `observed-roads.json`, die im Gebiet liegen – und setzt sie ein: Die neuen Straßen,
  Knoten und Ampelsteuerungen bekommen die Nummern der ersetzten (Überzählige hinten an, übrige Nummern halten
  Platzhalter weit außerhalb der Karte), ihre Höhen schließen an die des alten Netzes an. Alle anderen Nummern bleiben,
  damit auch Haltestellen, Buslinien, Adressen und Schilder. Die neu gebauten Straßen stehen in den Blöcken (`fresh`),
  der Kachelbau baut sie und ihre Kreuzungen neu, alle anderen mit `tools/mapgen/legacy/roadmesh.ts`.
- **OSM-Dinge** (Wege, Zäune, Flächen, Gebäude, Korrekturen, Grün aus Luftbildern) nach ihrer Mitte.
- **Bodenbedeckung** Kachel für Kachel (500 m), außerhalb mit `tools/mapgen/legacy/cover.ts`.
- **Schilder**: außerhalb wie in der veröffentlichten Karte (`legacy/signs.ts` = Stand 1.3.0, in den Kacheln des
  1.6.0-Patches `legacy/patch-1.6.0-tiles.json` der heutige), Gebäudefarben außerhalb aus
  `observed-buildings.published.json`.

`tools/mapgen/legacy/*` sind die Stände der veröffentlichten Karte: nicht verbessern. Den Release-Schritt macht

```bash
node tools/build-detail.ts            # Netz (~30 min, 4 GB) und Kacheln der Blöcke am Gebiet nach data/work/detail
# → data/work/detail/tiles-patch.tar: geänderte w/*.json.gz, net.bin.gz, tiles/*.fsb, map/patch.json
#   (dazu die Dateien früherer Patches); als tiles-patch.tar ans Karten-Release hängen
```

`tools/fetch-map.ts` packt es über die Karte aus und setzt `meta.patched` in `map.json` – Teil der Adresse jeder Datei
der Karte (Kacheln, Netz-Stücke, `net.bin.gz`), so dass kein Browser alte behält. `rails.json.gz` bleibt das
veröffentlichte (es enthält, was `map:stops` ergänzt). Ein Kasten mehr: in die Liste schreiben, `build-detail` laufen
lassen.

### Andere oder weitere Gemeinden?

Weitere hessische Kreise: mit `tools/fetch-geodata.py` laden und die Pipeline laufen lassen. Die Grenze
setzt GitHub Pages: Eine Seite darf 1 GB groß sein. Für andere Bundesländer müssen der Abruf und die Leser
für Höhenmodell und Gebäude an das jeweilige Lieferformat angepasst werden (viele Länder bieten ebenfalls
offene DGM1/LoD2-Daten).

#### Thüringen

Ablauf `.github/workflows/build-map-thueringen.yml` („Karte Thüringen“), Abruf `tools/fetch-it.py` (rechnet jedes UTM32-Rechteck aus dem Copernicus DEM):

| Inhalt | Quelle | Lizenz |
| --- | --- | --- |
| Gelände | Copernicus DEM GLO-30 (30 m, Oberflächenmodell) aus dem offenen Behälter `copernicus-dem-30m` – DGM1 und LoD2 des TLBG wären offen (© GDI-Th, CC BY 4.0 laut Katalog geomis.geoportal-th.de), sind aber nicht automatisch abrufbar: geoportal.thueringen.de zeigt jeder Anfrage eine CAPTCHA-Seite (Link11), der Dateiserver geoportal.geoportal-th.de meldet „nicht verfügbar“, der Geoproxy hat für Höhen nur WMS | GLO-30 frei und offen – „Produced using Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved“ |
| Gebäude | Umrisse aus OpenStreetMap (kein LoD2, s. o.) | ODbL 1.0 |
| OpenStreetMap | Geofabrik `europe/germany/thueringen` | ODbL 1.0 |

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

### Busse

Derselbe Lauf macht die Fahrpläne der Buslinien aus `buslines.json.gz` (er braucht sie und `stops.json.gz`, läuft
also nach `map:buslines`) – im selben Durchgang durch `stop_times.txt`, der die Zeit kostet. Sie stehen in
`timetable.json.gz` im Abschnitt `bus` (Dateiversion 2; das Spiel liest Dateien der Version 1 weiter).

- **Welche Fahrten:** Busse (`route_type` 3, 11 und 700–800) der KVG Kassel („KVG M“) und des NVV („NVV - Faisy“),
  nicht die Anruf-Sammel-Taxis („NVV … AST“) und nicht die anderen KVGs im Feed (Offenbach, Main-Kinzig,
  Salzland) – `GTFS_BUS_AGENCY` (ein regulärer Ausdruck) wählt andere, `GTFS_BUSES=0` lässt die Busse weg.
- **Zuordnung nach Nummer, Ort und Name:** Haltestellennamen wiederholen sich von Ort zu Ort („Rathaus“,
  „Bahnhof“), deshalb zählt zuerst, *wo* ein Halt liegt: bis 50 m vom Haltepunkt der Karte ist es derselbe, wie
  auch immer er heißt („Schule“, „Grundschule“), bis 400 m müssen die Namen passen (wie bei den Bahnen, auch mit
  dem Ort davor: „Baunatal Rathaus“), bis 1,5 km nur derselbe Name, weiter weg nichts. Jede Fahrt kommt zu der
  Linie gleicher Nummer, deren Halte sie in derselben Reihenfolge am meisten anfährt; was davor und danach
  bleibt, zur nächsten – so fährt eine Ringlinie, die OSM in zwei Relationen teilt, auf beiden (an der Stelle des
  Wechsels fährt sie als die zweite ab, der Anzeiger zeigt sie einmal).
- **Ziel:** wie die Fahrt es an jedem Halt anzeigt (`stop_headsign`), ohne die Zusätze der KVG („Ri. Am
  Kirschrain“, „(Endpunkt Bus)“, „Steig H“); ändert es sich unterwegs (eine Ringlinie nennt erst ihren
  Wendepunkt, dann ihr Ende), ist das je Halt vermerkt.
- **Farbe:** die der Linie in OSM, sonst die `route_color` des Feeds, sonst keine (auch für die Bahnen).
- **Klein gehalten:** Je Linie die Haltestellen (als Nummern in `stops.json.gz`, in der Reihenfolge, in der
  `src/world/buslines.ts` sie führt), je Fahrtverlauf die angefahrenen Halte, die Sekunden zwischen den
  Abfahrten, Standzeiten und Ziele, und die Abfahrten – alle aufsteigenden Listen als Schritte zur Zahl davor.
- **Stand November 2026:** 13 985 Busfahrten an den drei Tagen, 12 515 davon auf einer Linie der Karte;
  457 der 625 Buslinien (je Richtung) haben einen Fahrplan. Ohne: 59, deren Nummer der Feed bei diesen
  Betreibern nicht hat (meist Linien der Nachbarn, die in die Karte hineinfahren: Westfalen, Marburg und
  Vogelsberg, Göttingen, Thüringen), 67, deren Fahrten anders fahren als die Relation (oder eine andere Fahrtvariante
  der Linie passt besser), 42, von denen die Karte keine zwei Halte kennt.
- **Abfahrten im Spiel:** `src/sim/timetable.ts` fragt Bahnen und Busse zusammen ab – nach dem Haltepunkt
  (seiner Nummer in `stops.json.gz`; die Halte der Bahnen sind ihm über `stopPlaces` zugeordnet) oder nach dem
  Namen. Die Anzeiger an den Haltestellen (`src/render/transit.ts`) zeigen das: ein großer an den Halten der
  Bahn, an Haltestellen mit Wartehalle und wo OSM einen kennt, ein kleiner an einfachen Masten, wo Busse oder
  Bahnen des Fahrplans halten.

## Buslinien

`npm run map:buslines` (`tools/build-buslines.ts`) macht aus jeder Routen-Relation von OSM (`route=bus`,
`route=trolleybus`), die eine Straße der Karte berührt, eine Linie in `buslines.json.gz`: Nummer, Name, Start,
Ziel, Betreiber und Farbe, den Weg als Folge von Straßen der Karte mit ihrer Fahrtrichtung und die Halte mit
ihrer Stelle an diesem Weg. Die Busse im Verkehr fahren damit ihre Linie (`src/sim/traffic.ts`); ihre Fahrpläne
stehen in `timetable.json.gz` ([oben](#busse)).

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
