# German road signs (StVO / VzKat)

The official German traffic-sign graphics as published in the annexes of the
Straßenverkehrs-Ordnung (StVO) and in the Verkehrszeichenkatalog (VzKat), taken as SVG
from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Diagrams_of_road_signs_of_Germany).
`svg/<code>.svg` is the unmodified Commons original, `manifest.json` lists title (the
official VzKat name), Commons file, source page, licence, pixel size and outline shape per
code, and `signs.json` bundles all signs as `{ "<code>": "<svg …>" }` with comments, metadata
and editor data stripped and a `viewBox` added where the original has only `width`/`height`
(the drawing itself is untouched). Codes are VzKat numbers; speed
limits are keyed by their value (`274-30`, `278-60`), and the few keys that differ from the
catalogue number are explained by the `note` fields in `tools/signs/sign-sources.json`.

German road signs are official works (amtliche Werke) and thus in the public domain under
§ 5 Abs. 1 UrhG. A file is only accepted if its Commons licence metadata says "Public domain"
(recorded per sign in `manifest.json`), so the signs can ship with this AGPL-3.0-only project
without attribution duties. Do not edit anything here by hand: change
`tools/signs/sign-sources.json` and run `python3 -I tools/signs/fetch-signs.py` (standard
library only). Files that are unchanged on Commons are not downloaded again; Wikimedia lets
an anonymous client fetch only about one original file per minute, so a first full run takes
about three hours, and `manifest.json` / `signs.json` always list what is verified so far.
