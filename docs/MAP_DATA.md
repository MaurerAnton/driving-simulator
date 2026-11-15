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

Die Karte umfasst die Stadt **Baunatal** und die kreisfreie Stadt **Kassel** – ein Rechteck von 18 km × 18 km
(ETRS89/UTM32: Ost 522–540 km, Nord 5674–5692 km). Für beide Städte liegen Gelände und Gebäude vor; die
Ränder des Rechtecks außerhalb der beiden Stadtgebiete bleiben leer.

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
sind – auf zweigleisigen Strecken rechts, mit Halt an den Haltestellen. Fahrplan, Linien und Signale sind
nicht nachgebildet.

**Übungsplatz für den Lkw:** Die Karte merkt sich ein möglichst ebenes, freies Feld (150 m × 66 m, ohne
Straßen, Gebäude, Wald und Wasser) in der Nähe des ersten Startpunkts. Dort legt das Spiel für die
Grundfahraufgaben der Klasse CE Asphalt, Linien, Kegel und eine Rampe über das Gelände – nur während einer
solchen Fahrstunde; an der Karte selbst wird dafür nichts verändert, in Wirklichkeit ist dort ein Acker.

Das bedeutet: Lage und Art der *erfassten* Regelung stimmen mit der Wirklichkeit überein; ergänzte Schilder
stehen an plausibler Stelle, können im Einzelfall aber von der Örtlichkeit abweichen. Wer eine Abweichung
findet, trägt sie am besten in OpenStreetMap ein – nach dem nächsten Kartenlauf stimmt es dann auch hier.

## Karte neu bauen

Benötigt Node.js ≥ 24 und etwa 2 GB freien Speicher.

```bash
# 1. OpenStreetMap-Auszug Hessen (ca. 350 MB)
mkdir -p data/raw/osm data/raw/dgm1/tiles data/raw/lod2
curl -L -o data/raw/osm/hessen-latest.osm.pbf \
  https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf

# 2. DGM1 und LoD2 beider Städte aus dem Downloadcenter der HVBG:
#    https://gds.hessen.de → Downloadcenter → 3D-Daten
#      → Digitales Geländemodell (DGM1) → Landkreis Kassel → Baunatal-DGM1.zip
#      → Digitales Geländemodell (DGM1) → Kreisfreie Stadt Kassel → (Paket) Kassel-DGM1.zip
#      → 3D-Gebäudemodelle → 3D-Gebäudemodelle LoD2 → Landkreis Kassel → Baunatal-LoD2.zip
#      → 3D-Gebäudemodelle → 3D-Gebäudemodelle LoD2 → Kreisfreie Stadt Kassel → (Paket) Kassel-LoD2.zip
#    (Ein „Paket“ ist ein ZIP, in dem das eigentliche ZIP steckt: zweimal auspacken.)
unzip -o Baunatal-DGM1.zip -d data/raw/dgm1/tiles
unzip -o Kassel-DGM1.zip   -d data/raw/dgm1/tiles
unzip -o Baunatal-LoD2.zip -d data/raw/lod2      # Baunatal-LoD2.gml (0,45 GB)
unzip -o Kassel-LoD2.zip   -d data/raw/lod2      # Kassel-LoD2.gml (2,2 GB)

# 3. Pipeline (Zeiten auf einem kleinen ARM-Rechner; 8 GB Arbeitsspeicher reichen)
npm run map:extract   # schneidet das Kartenrechteck aus dem PBF (eigener PBF-Leser, ~4 min)
npm run map:lod2      # liest alle *.gml in data/raw/lod2 ein (~7 min)
npm run map:build     # baut Netz, Höhen, Vorfahrt, Schilder, Gebäude, Kacheln (~11 min)
npm run map:addresses # Adressliste (Hausnummern aus OSM) für „Start an einer Adresse“ (~1 min)
```

Mit `MAP_OUT=public/map.neu npm run map:build` (ebenso `map:addresses`) entsteht die Karte in einem anderen
Ordner und kann am Ende in einem Zug gegen `public/map` getauscht werden.

Die aktuellen Download-Adressen der HVBG enthalten ein Datum; die Verzeichnisstruktur lässt sich auch
maschinell abfragen:
`https://gds.hessen.de/INTERSHOP/rest/WFS/HLBG-Geodaten-Site/-/downloadcenter?path=3D-Daten/...`

### Stufen von `tools/build-map.ts`

1. **Bodenbedeckung** (`mapgen/cover.ts`): OSM-Flächen als 2-m-Raster (Wiese, Acker, Wald, Wohngebiet …);
   daraus auch die Maske „bebautes Gebiet“.
2. **Straßengraph** (`mapgen/roads.ts`): Wege → Knoten/Kanten, Attribute aus Tags, Abschneiden am Rand der
   Höhendaten, Ausrunden von Knicken.
3. **Höhen** (`mapgen/elevation.ts`): Geländehöhe je Stützpunkt, gemeinsame Glättung des ganzen Netzes;
   Brücken werden zwischen ihren Rampen frei gespannt, Unterführungen bei Bedarf abgesenkt.
4. **Vorfahrt** (`mapgen/control.ts`): Ampelanlagen und Phasen, Rollen jeder Zufahrt, Überwege, Abbiegeverbote.
5. **Kreuzungsgeometrie** (`src/world/world.ts`): Ausrundungen, Kreuzungsflächen, Bordsteinlinien – derselbe
   Code liefert später die Fahrbahnoberfläche für die Physik.
6. **Gelände** (`mapgen/terrain.ts`): 5-m-Raster, entlang der Straßen auf Fahrbahnniveau angeglichen.
7. **Netze** (`mapgen/roadmesh.ts`, `buildings.ts`, `objects.ts`, `signs.ts`): Fahrbahnen, Markierungen,
   Gehwege, Brücken, Gebäude, Schilder, Bäume, Laternen, Leitplanken, Gleise.
8. **Schienen und Übungsplatz** (`mapgen/rails.ts`, `mapgen/yard.ts`): das Gleisnetz für Straßenbahnen und
   Züge, das freie Feld für die Lkw-Fahrstunden.
9. **Kacheln**: 500-m-Kacheln (`public/map/tiles/*.fsb`, gzip) und `world.json` mit dem Straßennetz.

### Andere oder weitere Gemeinden?

Der Kartenausschnitt ist in `src/geo/utm.ts` festgelegt (`WORLD_MIN_E` … in ETRS89/UTM32), die Gemeinden,
für die Gelände und Gebäude vorliegen, stehen in `tools/build-map.ts` (`MUNICIPALITIES`: Name, Verwaltungsebene
der OSM-Grenze, zweite Zeile der Ortstafel). Für eine weitere hessische Gemeinde: Rechteck anpassen, deren
DGM1- und LoD2-Paket dazulegen, Gemeinde eintragen, Pipeline laufen lassen. Je größer das Rechteck, desto
länger dauert der Start des Spiels – das ganze Straßennetz wird am Anfang geladen (Baunatal und Kassel:
20 MB, gepackt 6 MB). Für andere
Bundesländer müssen die Leser für Höhenmodell und Gebäude an das jeweilige Lieferformat angepasst werden
(viele Länder bieten ebenfalls offene DGM1/LoD2-Daten).

## Koordinaten

Weltkoordinaten in Metern: `x` = Ost, `y` = Höhe über NHN (DHHN2016), `z` = Süd. Ursprung bei
E 528 000 / N 5 678 000 (ETRS89 / UTM Zone 32N, EPSG:25832), nahe der Baunataler Stadtmitte.
