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

### Warum keine Street-View- oder Satellitenbilder?

Werkzeuge wie *streetview-downloader*, *pano-fetcher* oder *SAS.Planet* laden Bilder kommerzieller Anbieter
(Google, Bing, Yandex …). Deren Nutzungsbedingungen verbieten es, daraus Kartendaten abzuleiten oder die
Bilder weiterzugeben – in einem freien Projekt, dessen Daten jeder weiterverwenden dürfen soll, haben sie
deshalb nichts verloren. *CoMaps* dagegen zeigt OpenStreetMap-Daten: Das ist genau die Quelle, die hier
verwendet wird. Dazu kommen die amtlichen, frei nutzbaren Geodaten des Landes Hessen, die genauer sind als
jedes Straßenfoto (Höhen auf Dezimeter, echte Dachformen).

Für die Zukunft bieten sich offene Straßenfotos an ([Panoramax](https://panoramax.fr),
[Mapillary](https://www.mapillary.com), jeweils frei lizenziert), um Schilderstandorte zu prüfen und
fehlende Schilder in OpenStreetMap nachzutragen.

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

# 2. DGM1 und LoD2 der Gemeinde aus dem Downloadcenter der HVBG:
#    https://gds.hessen.de → Downloadcenter → 3D-Daten
#      → Digitales Geländemodell (DGM1) → Landkreis Kassel → Baunatal-DGM1.zip
#      → 3D-Gebäudemodelle → 3D-Gebäudemodelle LoD2 → Landkreis Kassel → Baunatal-LoD2.zip
unzip -o Baunatal-DGM1.zip -d data/raw/dgm1/tiles
unzip -o Baunatal-LoD2.zip -d data/raw/lod2

# 3. Pipeline
npm run map:extract   # schneidet das Kartenrechteck aus dem PBF (eigener PBF-Leser, ~4 min)
npm run map:lod2      # liest das CityGML ein (~1,5 min)
npm run map:build     # baut Netz, Höhen, Vorfahrt, Schilder, Gebäude, Kacheln (~3 min)
```

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
8. **Kacheln**: 500-m-Kacheln (`public/map/tiles/*.fsb`, gzip) und `world.json` mit dem Straßennetz.

### Andere Gemeinde?

Der Kartenausschnitt ist in `src/geo/utm.ts` festgelegt (`WORLD_MIN_E` … in ETRS89/UTM32). Für eine andere
hessische Gemeinde: Rechteck anpassen, deren DGM1- und LoD2-Paket laden, Pipeline laufen lassen. Für andere
Bundesländer müssen die Leser für Höhenmodell und Gebäude an das jeweilige Lieferformat angepasst werden
(viele Länder bieten ebenfalls offene DGM1/LoD2-Daten).

## Koordinaten

Weltkoordinaten in Metern: `x` = Ost, `y` = Höhe über NHN (DHHN2016), `z` = Süd. Ursprung bei
E 528 000 / N 5 678 000 (ETRS89 / UTM Zone 32N, EPSG:25832), nahe der Baunataler Stadtmitte.
