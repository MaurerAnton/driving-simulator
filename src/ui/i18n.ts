// SPDX-License-Identifier: AGPL-3.0-only
/** Texts (German / English) and the catalogue of rule violations with their legal basis. */

export type Lang = 'de' | 'en';

type Pair = [de: string, en: string];

const UI: Record<string, Pair> = {
  title: ['Fahrsim Baunatal', 'Fahrsim Baunatal'],
  subtitle: ['Freier 3D-Fahrschulsimulator – deutsche Verkehrsregeln im echten Straßennetz', 'Free 3D driving-school simulator – German traffic rules on the real road network'],
  loading: ['Lade Karte …', 'Loading map …'],
  loadingTiles: ['Lade Umgebung …', 'Loading surroundings …'],
  start: ['Losfahren', 'Start driving'],
  free: ['Freie Fahrt', 'Free drive'],
  freeDesc: ['Fahre frei durch Baunatal. Der Fahrlehrer meldet sich bei Fehlern.', 'Drive freely through Baunatal. The instructor speaks up when you make a mistake.'],
  lessons: ['Fahrstunden', 'Lessons'],
  exam: ['Prüfungsfahrt', 'Driving test'],
  examDesc: ['Etwa 15 Minuten nach Ansage des Prüfers. Schwere Fehler beenden die Prüfung.', 'About 15 minutes following the examiner. Serious faults end the test.'],
  settings: ['Einstellungen', 'Settings'],
  controls: ['Steuerung', 'Controls'],
  about: ['Über das Projekt', 'About'],
  resume: ['Weiterfahren', 'Resume'],
  restart: ['Neu starten', 'Restart'],
  menu: ['Hauptmenü', 'Main menu'],
  paused: ['Pause', 'Paused'],
  startPoint: ['Startpunkt', 'Start point'],
  transmission: ['Getriebe', 'Transmission'],
  trAssist: ['Schaltgetriebe mit Kupplungshilfe', 'Manual with clutch assist'],
  trManual: ['Schaltgetriebe (Kupplung selbst)', 'Manual (own clutch)'],
  trAutomatic: ['Automatik', 'Automatic'],
  quality: ['Grafik', 'Graphics'],
  qLow: ['Niedrig', 'Low'],
  qMedium: ['Mittel', 'Medium'],
  qHigh: ['Hoch', 'High'],
  mirrors: ['Spiegel', 'Mirrors'],
  mOff: ['Aus', 'Off'],
  mAlt: ['Abwechselnd (schnell)', 'Alternating (fast)'],
  mFull: ['Jedes Bild', 'Every frame'],
  hudRules: ['Regel-Hilfe einblenden (Tempolimit, Vorfahrt)', 'Show rule assistance (speed limit, right of way)'],
  hudGear: ['Ganganzeige im Kombiinstrument', 'Gear indicator in the cluster'],
  voice: ['Gesprochene Ansagen', 'Spoken instructions'],
  volume: ['Lautstärke', 'Volume'],
  traffic: ['Verkehrsdichte', 'Traffic density'],
  language: ['Sprache', 'Language'],
  back: ['Zurück', 'Back'],
  result: ['Auswertung', 'Result'],
  passed: ['Bestanden', 'Passed'],
  failed: ['Nicht bestanden', 'Failed'],
  noFaults: ['Keine Fehler – sehr gut!', 'No faults – well done!'],
  faults: ['Fehler', 'Faults'],
  points: ['Fehlerpunkte', 'Fault points'],
  distance: ['Strecke', 'Distance'],
  duration: ['Dauer', 'Time'],
  hint: ['Hinweis', 'Hint'],
  minor: ['Leichter Fehler', 'Minor fault'],
  major: ['Schwerer Fehler', 'Serious fault'],
  fail: ['Gefährdung', 'Dangerous fault'],
  limitNone: ['frei', 'none'],
  walk: ['Schritt', 'walk'],
  startEngine: ['Motor starten: Enter halten', 'Start the engine: hold Enter'],
  releaseHandbrake: ['Handbremse lösen: Leertaste', 'Release the handbrake: Space'],
  fastenBelt: ['Anschnallen: B', 'Fasten your seat belt: B'],
  selectGear: ['Gang einlegen: E oder 1 (R = rückwärts)', 'Select a gear: E or 1 (R = reverse)'],
  selectDrive: ['Wählhebel auf D: E drücken (Q zurück zu N, R, P)', 'Move the selector to D: press E (Q back to N, R, P)'],
  pressClutch: ['Kupplung treten (Umschalt), dann schalten', 'Press the clutch (Shift), then change gear'],
  engineStalled: ['Motor abgewürgt – Enter zum Starten', 'Engine stalled – Enter to restart'],
  offMap: ['Ende der Karte – bitte wenden', 'End of the map – please turn round'],
  resetHint: ['T setzt das Auto zurück auf die Straße', 'T puts the car back on the road'],
  routeDone: ['Ziel erreicht', 'Destination reached'],
  navStraight: ['geradeaus', 'straight on'],
  navLeft: ['links abbiegen', 'turn left'],
  navRight: ['rechts abbiegen', 'turn right'],
  navUturn: ['wenden', 'turn round'],
  navIn: ['In {d} m {what}', 'In {d} m {what}'],
  navNow: ['Jetzt {what}', 'Now {what}'],
  navRoundabout: ['im Kreisverkehr die {n}. Ausfahrt nehmen', 'take the {n}. exit at the roundabout'],
  navFollow: ['Dem Straßenverlauf folgen', 'Follow the road'],
  navMotorway: ['auf die Autobahn auffahren', 'join the motorway'],
  credits: ['Kartendaten', 'Map data'],
  licence: ['Lizenz', 'Licence'],
  source: ['Quellcode', 'Source code'],
  help: ['Hilfe (F1)', 'Help (F1)'],
  gamepadFound: ['Controller erkannt', 'Controller detected'],
  webglMissing: ['Dieser Browser unterstützt kein WebGL 2.', 'This browser does not support WebGL 2.'],
};

export function tr(key: string, lang: Lang, params?: Record<string, string | number>): string {
  const p = UI[key];
  let s = p ? p[lang === 'de' ? 0 : 1] : key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export interface ViolationText {
  title: Pair;
  /** what the rule says and what to do instead */
  why: Pair;
  /** legal basis */
  ref: string;
}

export const VIOLATIONS: Record<string, ViolationText> = {
  speed: {
    title: ['Zu schnell: {speed} bei erlaubten {limit} km/h', 'Too fast: {speed} where {limit} km/h is allowed'],
    why: [
      'Die zulässige Höchstgeschwindigkeit gilt ab dem Schild. Innerorts sind ohne Schild 50 km/h erlaubt, außerorts 100 km/h.',
      'The limit applies from the sign onwards. Without a sign: 50 km/h in built-up areas, 100 km/h outside.',
    ],
    ref: '§ 3 StVO, Zeichen 274',
  },
  speedWalk: {
    title: ['Schrittgeschwindigkeit überschritten ({speed} km/h)', 'Walking pace exceeded ({speed} km/h)'],
    why: [
      'Im verkehrsberuhigten Bereich (Zeichen 325.1) gilt Schrittgeschwindigkeit; Fußgänger dürfen die ganze Straße benutzen.',
      'In a traffic-calmed area (sign 325.1) you must drive at walking pace; pedestrians may use the whole street.',
    ],
    ref: 'Anlage 3 StVO, Zeichen 325.1',
  },
  redLight: {
    title: ['Rote Ampel überfahren', 'Ran a red light'],
    why: ['Rot bedeutet: Halt vor der Kreuzung, an der Haltlinie warten.', 'Red means: stop before the junction and wait at the stop line.'],
    ref: '§ 37 Abs. 2 StVO',
  },
  amberLight: {
    title: ['Bei Gelb noch eingefahren', 'Entered on amber'],
    why: [
      'Gelb ordnet an: vor der Kreuzung auf das nächste Zeichen warten. Nur wer nicht mehr gefahrlos anhalten kann, fährt weiter.',
      'Amber orders you to wait for the next signal. Carry on only if you can no longer stop safely.',
    ],
    ref: '§ 37 Abs. 2 StVO',
  },
  stopSign: {
    title: ['Am Stoppschild nicht angehalten', 'Did not stop at the stop sign'],
    why: [
      'Zeichen 206: An der Haltlinie muss das Fahrzeug vollständig stehen, auch wenn frei ist. Dann Vorfahrt gewähren.',
      'Sign 206: the vehicle must come to a complete stop at the line even if the road is clear, then give way.',
    ],
    ref: 'Anlage 2 StVO, Zeichen 206',
  },
  prioritySign: {
    title: ['Vorfahrt missachtet', 'Failed to give way'],
    why: [
      'Zeichen 205 „Vorfahrt gewähren“: Der Verkehr auf der anderen Straße darf weder gefährdet noch wesentlich behindert werden.',
      'Sign 205 “give way”: traffic on the other road must neither be endangered nor substantially hindered.',
    ],
    ref: '§ 8 Abs. 2 StVO, Zeichen 205/206',
  },
  rightBeforeLeft: {
    title: ['Rechts vor links missachtet', 'Ignored “right before left”'],
    why: [
      'An Kreuzungen und Einmündungen ohne Schilder hat Vorfahrt, wer von rechts kommt – typisch in Wohngebieten und Tempo-30-Zonen.',
      'At junctions without signs, whoever comes from the right has priority – typical in residential areas and 30 km/h zones.',
    ],
    ref: '§ 8 Abs. 1 StVO',
  },
  priorityRoundabout: {
    title: ['Vorfahrt im Kreisverkehr missachtet', 'Failed to give way at the roundabout'],
    why: [
      'Mit Zeichen 215 und 205 hat der Verkehr auf der Kreisfahrbahn Vorfahrt. Beim Einfahren wird nicht geblinkt, beim Ausfahren rechts.',
      'With signs 215 and 205, traffic on the roundabout has priority. Do not indicate when entering; indicate right when leaving.',
    ],
    ref: '§ 8 Abs. 1a StVO',
  },
  priorityDriveway: {
    title: ['Beim Einfahren auf die Straße andere gefährdet', 'Endangered others when pulling onto the road'],
    why: [
      'Wer aus einem Grundstück, Parkplatz, verkehrsberuhigten Bereich oder Feldweg auf die Straße fährt, muss jede Gefährdung ausschließen.',
      'Coming out of a property, car park, traffic-calmed area or farm track you must rule out any danger to others.',
    ],
    ref: '§ 10 StVO',
  },
  leftTurnOncoming: {
    title: ['Beim Abbiegen den Gegenverkehr nicht durchgelassen', 'Did not let oncoming traffic pass when turning'],
    why: [
      'Wer links abbiegen will, muss entgegenkommende Fahrzeuge durchfahren lassen – auch bei grüner Ampel ohne Pfeil.',
      'Turning left you must let oncoming vehicles pass – also on a green light without an arrow.',
    ],
    ref: '§ 9 Abs. 3 StVO',
  },
  cutOff: {
    title: ['Anderen geschnitten oder ausgebremst', 'Cut in front of another vehicle'],
    why: [
      'Beim Anfahren, Einfädeln und Fahrstreifenwechsel darf niemand gefährdet werden: Spiegel, Schulterblick, Blinker, Lücke abwarten.',
      'When pulling out, merging or changing lanes nobody may be endangered: mirrors, shoulder check, indicator, wait for a gap.',
    ],
    ref: '§ 1 Abs. 2, § 7 Abs. 5, § 10 StVO',
  },
  zebra: {
    title: ['Fußgänger am Zebrastreifen nicht beachtet', 'Ignored a pedestrian at the zebra crossing'],
    why: [
      'Wer den Überweg erkennbar benutzen will, hat Vorrang. Mit mäßiger Geschwindigkeit heranfahren und wenn nötig warten.',
      'Anyone visibly wanting to cross has priority. Approach at moderate speed and wait if necessary.',
    ],
    ref: '§ 26 Abs. 1 StVO, Zeichen 350',
  },
  zebraSpeed: {
    title: ['Zu schnell an den Fußgängerüberweg herangefahren', 'Approached the pedestrian crossing too fast'],
    why: ['An Fußgängerüberwegen nur mit mäßiger Geschwindigkeit heranfahren, wenn jemand queren könnte.', 'Approach pedestrian crossings at moderate speed when someone might cross.'],
    ref: '§ 26 Abs. 1 StVO',
  },
  pedestrian: {
    title: ['Fußgänger gefährdet', 'Endangered a pedestrian'],
    why: ['Fußgänger sind die schwächsten Verkehrsteilnehmer. Wer sie gefährdet, besteht keine Prüfung.', 'Pedestrians are the most vulnerable road users. Endangering them fails any test.'],
    ref: '§ 1 Abs. 2, § 3 Abs. 2a StVO',
  },
  noIndicator: {
    title: ['Abbiegen ohne Blinker', 'Turned without indicating'],
    why: [
      'Wer abbiegen will, muss dies rechtzeitig und deutlich ankündigen – der Blinker bleibt an, bis der Vorgang beendet ist.',
      'Announce a turn clearly and in good time – keep the indicator on until the manoeuvre is finished.',
    ],
    ref: '§ 9 Abs. 1 StVO',
  },
  wrongIndicator: {
    title: ['Falsch geblinkt', 'Wrong indicator'],
    why: ['Der Blinker muss zur tatsächlichen Fahrtrichtung passen; falsches Blinken täuscht andere.', 'The indicator must match where you actually go; a wrong signal misleads others.'],
    ref: '§ 9 Abs. 1 StVO',
  },
  indicatorLeftOn: {
    title: ['Blinker vergessen auszuschalten', 'Indicator left on'],
    why: ['Ein dauerhaft laufender Blinker kündigt ein Abbiegen an, das nicht kommt.', 'A forgotten indicator announces a turn that never happens.'],
    ref: '§ 9 Abs. 1 StVO',
  },
  noShoulderCheck: {
    title: ['Schulterblick fehlt', 'No shoulder check'],
    why: [
      'Vor dem Abbiegen nochmals auf den nachfolgenden Verkehr achten: Radfahrer im toten Winkel sieht man nur mit Blick über die Schulter (J / K oder Maus).',
      'Check following traffic again before turning: cyclists in the blind spot are only seen with a look over the shoulder (J / K or mouse).',
    ],
    ref: '§ 9 Abs. 1, Abs. 3 StVO',
  },
  roundaboutEntryIndicator: {
    title: ['Beim Einfahren in den Kreisverkehr geblinkt', 'Indicated when entering the roundabout'],
    why: ['Bei der Einfahrt in den Kreisverkehr wird nicht geblinkt – nur beim Verlassen rechts.', 'Do not indicate when entering a roundabout – only right when leaving.'],
    ref: '§ 8 Abs. 1a StVO',
  },
  roundaboutExitIndicator: {
    title: ['Kreisverkehr ohne Blinker verlassen', 'Left the roundabout without indicating'],
    why: ['Das Ausfahren aus dem Kreisverkehr ist ein Abbiegen und muss rechts angezeigt werden.', 'Leaving a roundabout is a turn and must be indicated to the right.'],
    ref: '§ 8 Abs. 1a, § 9 Abs. 1 StVO',
  },
  turnBan: {
    title: ['Verbotene Fahrtrichtung genommen', 'Took a prohibited direction'],
    why: ['Vorgeschriebene Fahrtrichtungen (blaue Pfeilschilder) und Abbiegeverbote sind verbindlich.', 'Mandatory directions (blue arrow signs) and turn bans are binding.'],
    ref: 'Anlage 2 StVO, Zeichen 209–214',
  },
  wrongWay: {
    title: ['Entgegen der Fahrtrichtung gefahren', 'Drove against the direction of traffic'],
    why: ['Zeichen 267 verbietet die Einfahrt; Einbahnstraßen dürfen nur in Pfeilrichtung befahren werden.', 'Sign 267 forbids entry; one-way streets may only be used in the direction of the arrow.'],
    ref: 'Anlage 2 StVO, Zeichen 220, 267',
  },
  keepRight: {
    title: ['Rechtsfahrgebot missachtet', 'Not keeping to the right'],
    why: ['Es ist möglichst weit rechts zu fahren, nicht nur bei Gegenverkehr, beim Überholtwerden oder an Kuppen und in Kurven.', 'Keep as far right as possible – not only with oncoming traffic, when being overtaken, on crests or in bends.'],
    ref: '§ 2 Abs. 2 StVO',
  },
  sidewalk: {
    title: ['Gehweg befahren', 'Drove on the pavement'],
    why: ['Fahrzeuge müssen die Fahrbahn benutzen. Der Gehweg gehört den Fußgängern.', 'Vehicles must use the carriageway. The pavement belongs to pedestrians.'],
    ref: '§ 2 Abs. 1 StVO',
  },
  offRoad: {
    title: ['Fahrbahn verlassen', 'Left the road'],
    why: ['Bleib auf der Fahrbahn; Seitenstreifen und Grünflächen sind kein Fahrstreifen.', 'Stay on the carriageway; verges and green areas are not lanes.'],
    ref: '§ 2 Abs. 1 StVO',
  },
  accessPrivate: {
    title: ['Verbotene Zufahrt', 'No entry for vehicles'],
    why: ['Zeichen 250 verbietet Fahrzeuge aller Art; private Zufahrten und Werksgelände sind tabu.', 'Sign 250 prohibits all vehicles; private drives and company premises are off limits.'],
    ref: 'Anlage 2 StVO, Zeichen 250',
  },
  accessAgricultural: {
    title: ['Wirtschaftsweg befahren', 'Used a farm track'],
    why: ['Feld- und Waldwege sind meist nur für land- und forstwirtschaftlichen Verkehr frei (Zeichen 260 mit Zusatzzeichen).', 'Farm and forest tracks are usually open to agricultural and forestry traffic only (sign 260 with plate).'],
    ref: 'Anlage 2 StVO, Zeichen 250/260',
  },
  accessDestination: {
    title: ['Nur für Anlieger frei', 'Residents and visitors only'],
    why: ['„Anlieger frei“ erlaubt die Durchfahrt nur, wer dort ein Ziel hat.', '“Anlieger frei” allows entry only if your destination is there.'],
    ref: 'Zusatzzeichen 1020-30',
  },
  distance: {
    title: ['Zu dicht aufgefahren ({gap} m)', 'Following too closely ({gap} m)'],
    why: ['Faustregel außerorts: halber Tacho in Metern. Innerorts mindestens eine Sekunde Abstand.', 'Rule of thumb outside towns: half the speedometer reading in metres. In town at least one second.'],
    ref: '§ 4 Abs. 1 StVO',
  },
  crash: {
    title: ['Zusammenstoß mit einem anderen Fahrzeug', 'Collision with another vehicle'],
    why: ['Ein Unfall beendet jede Prüfungsfahrt. Vorausschauend fahren und bremsbereit sein.', 'A collision ends every driving test. Look ahead and be ready to brake.'],
    ref: '§ 1 Abs. 2 StVO',
  },
  crashObject: {
    title: ['Gegen ein Hindernis gefahren ({speed} km/h)', 'Hit an obstacle ({speed} km/h)'],
    why: ['Geschwindigkeit und Abstand so wählen, dass das Fahrzeug jederzeit beherrscht wird.', 'Choose speed and distance so that the vehicle is under control at all times.'],
    ref: '§ 3 Abs. 1 StVO',
  },
  stall: {
    title: ['Motor abgewürgt', 'Engine stalled'],
    why: ['Kupplung langsam bis zum Schleifpunkt kommen lassen, etwas Gas geben, dann ganz lösen.', 'Let the clutch come up slowly to the biting point, add a little throttle, then release fully.'],
    ref: 'Fahrzeugbedienung',
  },
  seatbelt: {
    title: ['Nicht angeschnallt', 'Seat belt not fastened'],
    why: ['Vorgeschriebene Sicherheitsgurte müssen während der Fahrt angelegt sein.', 'Prescribed seat belts must be worn while driving.'],
    ref: '§ 21a Abs. 1 StVO',
  },
  handbrakeOn: {
    title: ['Mit angezogener Handbremse gefahren', 'Driving with the handbrake on'],
    why: ['Vor dem Anfahren die Feststellbremse lösen (Kontrollleuchte beachten).', 'Release the parking brake before driving off (watch the warning lamp).'],
    ref: 'Fahrzeugbedienung',
  },
};

export function violationTitle(id: string, lang: Lang, data: Record<string, number | string>): string {
  const v = VIOLATIONS[id];
  if (!v) return id;
  let s = v.title[lang === 'de' ? 0 : 1];
  for (const [k, val] of Object.entries(data)) s = s.replace(`{${k}}`, String(val));
  return s;
}

export function violationWhy(id: string, lang: Lang): string {
  const v = VIOLATIONS[id];
  return v ? v.why[lang === 'de' ? 0 : 1] : '';
}
