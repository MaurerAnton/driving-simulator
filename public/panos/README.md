# Eigene Straßenbilder für die Realansicht · Your own street-level pictures

*English below.*

Die **Realansicht** des Simulators (Taste `F`) zeigt echte Fotos der Stelle, an der das Auto steht. Neben den
freien Bilddiensten (Panoramax, KartaView, Mapillary) kann sie **eigene Bilder** anzeigen – zum Beispiel
360°-Panoramen, die du mit einem Street-View-Downloader gespeichert hast, Standbilder einer Dashcam oder
Handyfotos.

Dafür gibt es zwei Wege:

1. **Im Spiel laden** (für alle, auch auf der öffentlichen Seite): in der Realansicht „Bilder wählen …“ oder
   „Ordner wählen …“ anklicken oder die Dateien auf das Fenster ziehen. Die Bilder bleiben auf deinem Gerät
   und werden nirgends hochgeladen; nach dem Schließen der Seite sind sie wieder weg.
2. **In diesen Ordner legen** (für eine selbst betriebene Kopie): Bilder nach `public/panos/` kopieren und
   einmal `npm run panos:index` ausführen. Das Werkzeug schreibt `public/panos/index.json`; die Bilder sind
   danach für alle Besucher dieser Kopie da.

## Was verstanden wird

- **Formate:** JPEG, PNG, WebP (und was der Browser sonst anzeigen kann).
- **360°-Panoramen** werden erkannt an den Photo-Sphere-Metadaten (`GPano:ProjectionType=equirectangular`,
  wie sie etwa `streetview-dl` schreibt) oder – ohne Metadaten – am Seitenverhältnis 2 : 1. Sie werden als
  Kugel dargestellt, in der man sich umsehen kann; alles andere als flaches Foto.
- **Position und Blickrichtung** kommen, in dieser Reihenfolge, aus
  1. den Metadaten der Datei: EXIF-GPS (`GPSLatitude`, `GPSLongitude`, `GPSImgDirection`) und XMP
     (`GPano:PoseHeadingDegrees`, `exif:GPSLatitude` …);
  2. einer Liste im selben Ordner, die Dateiname oder Panorama-ID und Koordinaten enthält:
     JSON, GeoJSON, CSV/TSV – und beim Werkzeug `npm run panos:index` auch ein GeoPackage (`metadata.gpkg`),
     wie es `streetviewdownloader` anlegt;
  3. dem Dateinamen: `51.25529,9.41110.jpg`, `pano_51.25529_9.41110_h090.jpg`, `<Panorama-ID>_090.jpg`
     (die Zahl am Ende ist die Blickrichtung in Grad).
- Bilder **ohne Position** lassen sich in der Realansicht mit „An dieser Stelle ablegen“ dem aktuellen
  Standort zuordnen.

## Lizenz beachten

Der Ordner steht absichtlich in `.gitignore`: Bilder, an denen du keine Weitergaberechte hast – etwa von
Google Street View –, dürfen deinen Rechner nicht verlassen und gehören weder in ein öffentliches Repository
noch auf einen öffentlichen Server. Veröffentlichen darfst du eigene Fotos und frei lizenzierte Bilder
(z. B. von Panoramax, KartaView oder Mapillary unter CC BY-SA 4.0, mit Namensnennung).

---

## English

The simulator's **reality view** (key `F`) shows real photographs of the place the car is at. Besides the free
imagery services (Panoramax, KartaView, Mapillary) it can show **your own pictures** – 360° panoramas saved
with a street-view download tool, dashcam stills or phone photos.

1. **Load them in the game** (works for everybody, also on the public site): in the reality view choose
   "Choose pictures …" or "Choose a folder …", or drop the files on the window. They stay on your device, are
   not uploaded anywhere and are gone when you close the page.
2. **Put them into this folder** (for a copy you host yourself): copy the pictures to `public/panos/` and run
   `npm run panos:index` once. It writes `public/panos/index.json`; the pictures are then there for every
   visitor of that copy.

What is understood: JPEG, PNG and WebP; 360° panoramas by their Photo Sphere metadata
(`GPano:ProjectionType=equirectangular`) or, without metadata, by their 2 : 1 shape; position and viewing
direction from EXIF GPS / XMP, from a list next to the pictures (JSON, GeoJSON, CSV/TSV, and with the indexing
tool a GeoPackage `metadata.gpkg`) or from the file name (`51.25529,9.41110.jpg`,
`pano_51.25529_9.41110_h090.jpg`, `<panorama id>_090.jpg`). Pictures without a position can be pinned to the
place the car is at.

Mind the licence: the folder is ignored by git on purpose. Pictures you have no right to redistribute –
Google Street View, for one – must not leave your machine. Publish only your own photos and freely licensed
pictures (with attribution).
