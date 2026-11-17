// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Traffic signs drawn by the program: those of the official catalogue
 * (Verkehrszeichenkatalog, VzKat) that have no graphic in
 * public/signs/signs.json, and those whose plate shows a value only the map
 * knows – the time of a panel ("22–6 h", "Mo–Fr 7–17 h"), a mass, a width,
 * a distance.  German traffic signs are official works and in the public
 * domain (§ 5 Abs. 1 UrhG); they are drawn here from their description, in
 * their colours and shapes, simplified where a pictogram is involved.
 *
 * A code is a catalogue number ("1026-37", "257-54"), with what the plate
 * shows after the first colon: "1040-30:22:00-06:00" (a time as
 * OpenStreetMap writes it, src/sim/signtime.ts), "262:7.5", "1004-30:150".
 * `drawSignArt` draws one into a rectangle of the atlas and says whether it
 * knew the sign; `artAspect` gives the width / height of its plate.
 */
import { parseTimeWindow, windowLines } from '../sim/signtime.ts';

const FONT = '"DIN 1451 Std", "DIN Alternate", "Bahnschrift", "Roboto Condensed", "Arial Narrow", "Liberation Sans Narrow", "Helvetica Neue", Arial, sans-serif';

const RED = '#c1121c';
const BLUE = '#1b5fa8';
const YELLOW = '#f6d417';
const BLACK = '#111';
const WHITE = '#fff';

type G = CanvasRenderingContext2D;

/** "1040-30:22:00-06:00" → ["1040-30", "22:00-06:00"] (only the first colon parts them) */
export function splitCode(code: string): [string, string] {
  const i = code.indexOf(':');
  return i < 0 ? [code, ''] : [code.slice(0, i), code.slice(i + 1)];
}

// ------------------------------------------------------------------ pictograms (in a box of 100 × 100, centred)

/** A pictogram, drawn in the current colour into the box (0, 0) … (100, 100). */
type Glyph = (g: G) => void;

function wheel(g: G, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function poly(g: G, pts: number[]): void {
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) g.moveTo(pts[i], pts[i + 1]);
    else g.lineTo(pts[i], pts[i + 1]);
  }
  g.closePath();
  g.fill();
}

function line(g: G, width: number, ...pts: number[]): void {
  g.lineWidth = width;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) g.moveTo(pts[i], pts[i + 1]);
    else g.lineTo(pts[i], pts[i + 1]);
  }
  g.stroke();
}

const car: Glyph = (g) => {
  poly(g, [8, 62, 10, 50, 26, 46, 36, 32, 66, 32, 78, 46, 92, 50, 94, 62]);
  wheel(g, 27, 63, 9);
  wheel(g, 75, 63, 9);
};

const truck: Glyph = (g) => {
  // the box, the cab in front (right), the wheels
  g.fillRect(4, 24, 62, 38);
  poly(g, [69, 62, 69, 32, 86, 32, 96, 46, 96, 62]);
  wheel(g, 20, 66, 8);
  wheel(g, 38, 66, 8);
  wheel(g, 82, 66, 8);
};

const bus: Glyph = (g) => {
  poly(g, [4, 64, 4, 28, 90, 28, 96, 40, 96, 64]);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let x = 10; x < 82; x += 15) g.fillRect(x, 33, 11, 11);
  g.restore();
  wheel(g, 22, 66, 8);
  wheel(g, 78, 66, 8);
};

const bike: Glyph = (g) => {
  g.lineWidth = 5;
  for (const x of [24, 76]) {
    g.beginPath();
    g.arc(x, 62, 17, 0, Math.PI * 2);
    g.stroke();
  }
  line(g, 5, 24, 62, 40, 36, 66, 36, 76, 62);
  line(g, 5, 40, 36, 50, 62, 66, 36);
  line(g, 5, 36, 30, 46, 30);
  line(g, 5, 66, 36, 62, 26, 70, 24);
};

const motorbike: Glyph = (g) => {
  wheel(g, 22, 64, 14);
  wheel(g, 80, 64, 14);
  poly(g, [22, 58, 36, 40, 62, 40, 72, 30, 80, 32, 82, 64, 60, 60, 44, 64]);
  // the rider
  poly(g, [40, 40, 48, 18, 58, 18, 62, 40]);
  wheel(g, 56, 12, 7);
};

const moped: Glyph = (g) => {
  bike(g);
  g.fillRect(40, 50, 18, 12);
};

const person: Glyph = (g) => {
  wheel(g, 52, 12, 9);
  line(g, 9, 51, 24, 47, 56);
  line(g, 7, 47, 56, 36, 92);
  line(g, 7, 47, 56, 62, 92);
  line(g, 6, 50, 28, 36, 50);
  line(g, 6, 50, 28, 64, 46);
};

const children: Glyph = (g) => {
  g.save();
  g.translate(-14, 0);
  person(g);
  g.restore();
  g.save();
  g.translate(48, 22);
  g.scale(0.72, 0.78);
  person(g);
  g.restore();
};

const cow: Glyph = (g) => {
  poly(g, [16, 34, 72, 34, 80, 26, 94, 30, 92, 42, 82, 44, 78, 58, 18, 58, 12, 44]);
  for (const x of [20, 30, 62, 72]) g.fillRect(x, 56, 6, 26);
  line(g, 4, 14, 38, 6, 60);
};

const deer: Glyph = (g) => {
  poly(g, [14, 52, 30, 34, 58, 30, 70, 20, 74, 8, 80, 20, 90, 22, 84, 32, 70, 40, 62, 50, 40, 52]);
  line(g, 5, 74, 8, 70, 0, 66, 6);
  line(g, 5, 74, 8, 82, 0, 86, 6);
  line(g, 6, 22, 50, 8, 70);
  line(g, 6, 30, 50, 22, 74);
  line(g, 6, 58, 48, 76, 68);
  line(g, 6, 64, 46, 86, 60);
};

const horse: Glyph = (g) => {
  poly(g, [14, 42, 26, 34, 62, 34, 72, 20, 80, 12, 92, 18, 88, 26, 80, 30, 76, 50, 64, 56, 24, 56]);
  line(g, 6, 22, 54, 14, 84);
  line(g, 6, 30, 54, 30, 84);
  line(g, 6, 60, 54, 62, 84);
  line(g, 6, 68, 52, 76, 82);
};

const rider: Glyph = (g) => {
  horse(g);
  poly(g, [36, 34, 42, 10, 52, 10, 54, 34]);
  wheel(g, 48, 4, 6);
};

const tram: Glyph = (g) => {
  poly(g, [8, 70, 8, 30, 92, 30, 92, 70]);
  g.save();
  g.globalCompositeOperation = 'destination-out';
  for (let x = 14; x < 86; x += 18) g.fillRect(x, 36, 12, 14);
  g.restore();
  line(g, 4, 40, 30, 50, 14, 60, 30);
  line(g, 4, 34, 14, 66, 14);
  wheel(g, 24, 72, 6);
  wheel(g, 76, 72, 6);
};

const tractor: Glyph = (g) => {
  g.lineWidth = 6;
  g.beginPath();
  g.arc(28, 60, 20, 0, Math.PI * 2);
  g.stroke();
  wheel(g, 80, 70, 10);
  poly(g, [16, 40, 16, 16, 44, 16, 50, 40, 92, 44, 92, 60, 48, 60]);
};

const trailerCar: Glyph = (g) => {
  g.save();
  g.translate(32, 10);
  g.scale(0.68, 0.8);
  car(g);
  g.restore();
  g.fillRect(4, 40, 26, 22);
  wheel(g, 17, 64, 6);
  line(g, 4, 28, 58, 40, 58);
};

const trailerTruck: Glyph = (g) => {
  g.save();
  g.translate(36, 12);
  g.scale(0.64, 0.8);
  truck(g);
  g.restore();
  g.fillRect(2, 32, 32, 30);
  wheel(g, 10, 66, 6);
  wheel(g, 25, 66, 6);
};

const camper: Glyph = (g) => {
  poly(g, [4, 64, 4, 22, 66, 22, 74, 34, 90, 40, 96, 52, 96, 64]);
  wheel(g, 22, 66, 8);
  wheel(g, 78, 66, 8);
};

const scooter: Glyph = (g) => {
  wheel(g, 22, 80, 8);
  wheel(g, 78, 80, 8);
  line(g, 7, 22, 78, 78, 78);
  line(g, 7, 70, 78, 60, 18);
  line(g, 7, 50, 18, 70, 18);
};

const cargoBike: Glyph = (g) => {
  bike(g);
  g.fillRect(2, 32, 26, 14);
};

const wheelchair: Glyph = (g) => {
  wheel(g, 44, 10, 8);
  line(g, 9, 44, 24, 44, 50, 70, 50, 80, 74);
  g.lineWidth = 6;
  g.beginPath();
  g.arc(44, 64, 24, -0.5, Math.PI * 1.6);
  g.stroke();
};

const plane: Glyph = (g) => {
  poly(g, [6, 52, 30, 46, 78, 44, 94, 36, 96, 44, 84, 52, 78, 58, 30, 56]);
  poly(g, [44, 46, 60, 18, 70, 18, 62, 46]);
  poly(g, [46, 56, 58, 82, 68, 82, 64, 56]);
};

const hazardPlate: Glyph = (g) => {
  g.fillStyle = '#f08a00';
  g.fillRect(14, 26, 72, 48);
  g.strokeStyle = BLACK;
  g.lineWidth = 4;
  g.strokeRect(14, 26, 72, 48);
  line(g, 4, 14, 50, 86, 50);
};

const drops: Glyph = (g) => {
  car(g);
  for (const [x, y] of [
    [30, 86],
    [52, 92],
    [74, 86],
  ]) {
    g.beginPath();
    g.moveTo(x, y - 12);
    g.quadraticCurveTo(x + 7, y, x, y + 4);
    g.quadraticCurveTo(x - 7, y, x, y - 12);
    g.fill();
  }
};

/** A pictogram scaled into the rectangle (x, y, w, h), keeping its proportions; `flip`: mirrored. */
function glyphIn(g: G, glyph: Glyph, x: number, y: number, w: number, h: number, color = BLACK, flip = false): void {
  const s = Math.min(w, h) / 100;
  g.save();
  g.translate(x + w / 2, y + h / 2);
  g.scale(flip ? -s : s, s);
  g.translate(-50, -50);
  g.fillStyle = color;
  g.strokeStyle = color;
  glyph(g);
  g.restore();
}

// ------------------------------------------------------------------ plates

/** Text fitted into a width: as large as `size`, smaller if it would not fit. */
function text(g: G, t: string, cx: number, cy: number, maxW: number, size: number, color = BLACK, weight = 'bold'): void {
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${weight} ${size}px ${FONT}`;
  const w = g.measureText(t).width;
  if (w > maxW) g.font = `${weight} ${Math.max(6, (size * maxW) / w)}px ${FONT}`;
  g.fillText(t, cx, cy);
}

/** A rectangle with rounded corners as a path (a plain one where the browser has no roundRect). */
function rrect(g: G, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(x, y, w, h, Math.max(0, r));
  else g.rect(x, y, w, h);
}

/** A white panel with a black edge (Zusatzzeichen), filling (x, y, w, h). */
function panel(g: G, x: number, y: number, w: number, h: number): void {
  const r = Math.min(w, h) * 0.06;
  g.fillStyle = BLACK;
  rrect(g, x, y, w, h, r);
  g.fill();
  const b = Math.max(2, Math.min(w, h) * 0.035);
  g.fillStyle = WHITE;
  rrect(g, x + b, y + b, w - 2 * b, h - 2 * b, Math.max(1, r - b));
  g.fill();
}

/** Lines of text on a panel, each as large as fits. */
function panelLines(g: G, lines: string[], x: number, y: number, w: number, h: number): void {
  const n = lines.length;
  const pad = h * 0.1;
  const lh = (h - 2 * pad) / n;
  const size = Math.min(lh * 0.86, h * 0.44);
  lines.forEach((t, i) => text(g, t, x + w / 2, y + pad + lh * (i + 0.53), w * 0.88, size));
}

/** A round sign: white with a red rim (a prohibition) or blue with a white rim (a mandatory sign). */
function round(g: G, cx: number, cy: number, r: number, kind: 'ban' | 'blue'): void {
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = kind === 'ban' ? RED : WHITE;
  g.fill();
  g.beginPath();
  g.arc(cx, cy, r * (kind === 'ban' ? 0.8 : 0.93), 0, Math.PI * 2);
  g.fillStyle = kind === 'ban' ? WHITE : BLUE;
  g.fill();
}

/** A danger sign: the red triangle on its base, white inside. */
function triangle(g: G, x: number, y: number, w: number, h: number): void {
  g.fillStyle = RED;
  g.beginPath();
  g.moveTo(x + w / 2, y);
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.closePath();
  g.fill();
  const k = 0.17;
  g.fillStyle = WHITE;
  g.beginPath();
  g.moveTo(x + w / 2, y + h * k * 1.25);
  g.lineTo(x + w * (1 - k * 0.9), y + h * (1 - k * 0.55));
  g.lineTo(x + w * k * 0.9, y + h * (1 - k * 0.55));
  g.closePath();
  g.fill();
}

/** A blue rectangle with a white edge (a sign of guidance: parking, a dead end …). */
function blueSquare(g: G, x: number, y: number, w: number, h: number): void {
  g.fillStyle = WHITE;
  rrect(g, x, y, w, h, Math.min(w, h) * 0.06);
  g.fill();
  const b = Math.min(w, h) * 0.04;
  g.fillStyle = BLUE;
  rrect(g, x + b, y + b, w - 2 * b, h - 2 * b, Math.min(w, h) * 0.04);
  g.fill();
}

/** A yellow board with a black edge (the signs of a detour). */
function yellowBoard(g: G, x: number, y: number, w: number, h: number): void {
  g.fillStyle = BLACK;
  g.fillRect(x, y, w, h);
  const b = Math.min(w, h) * 0.05;
  g.fillStyle = YELLOW;
  g.fillRect(x + b, y + b, w - 2 * b, h - 2 * b);
}

/** Red and white stripes, slanting (beacons, barriers): `dir` +1 down to the right, −1 down to the left. */
function stripes(g: G, x: number, y: number, w: number, h: number, dir: number, n: number): void {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = WHITE;
  g.fillRect(x, y, w, h);
  g.fillStyle = RED;
  const step = Math.max(w, h) / n;
  const span = w + h;
  for (let k = -span; k < span * 2; k += step * 2) {
    g.beginPath();
    if (dir > 0) {
      g.moveTo(x + k, y);
      g.lineTo(x + k + step, y);
      g.lineTo(x + k + step - h, y + h);
      g.lineTo(x + k - h, y + h);
    } else {
      g.moveTo(x + k, y);
      g.lineTo(x + k + step, y);
      g.lineTo(x + k + step + h, y + h);
      g.lineTo(x + k + h, y + h);
    }
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** An arrow pointing along `angle` (0 = up, clockwise in radians), centred at (cx, cy). */
function arrow(g: G, cx: number, cy: number, len: number, angle: number, color: string, width = len * 0.18): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(angle);
  g.fillStyle = color;
  g.fillRect(-width / 2, -len * 0.2, width, len * 0.7);
  g.beginPath();
  g.moveTo(0, -len / 2);
  g.lineTo(width * 1.6, -len * 0.18);
  g.lineTo(-width * 1.6, -len * 0.18);
  g.closePath();
  g.fill();
  g.restore();
}

// ------------------------------------------------------------------ what each sign shows

/** "7.5" → "7,5" (the comma of German plates) */
const de = (v: string): string => v.replace('.', ',');

/** a value with its unit: "150" → "150 m"; "1 km" stays */
const withUnit = (v: string, unit: string): string => (/[a-z]/i.test(v) ? v : `${de(v)} ${unit}`);

/** The panels with words, by their number (VzKat 2017; the older number where only that one is in use). */
const WORDS: Record<string, string[]> = {
  '1006-31': ['Unfallgefahr'],
  '1007-30': ['Ölspur'],
  '1007-31': ['Rauch'],
  '1007-32': ['Rollsplitt'],
  '1007-33': ['Baustellen-', 'ausfahrt'],
  '1007-34': ['Straßen-', 'schäden'],
  '1007-35': ['Verschmutzte', 'Fahrbahn'],
  '1007-36': ['Spreng-', 'arbeiten'],
  '1007-37': ['Ausfahrt'],
  '1007-38': ['Baustellen-', 'verkehr'],
  '1007-39': ['fehlende', 'Fahrbahn-', 'markierung'],
  '1007-50': ['Unfall'],
  '1007-51': ['Hochwasser'],
  '1007-52': ['neuer', 'Fahrbahnbelag'],
  '1007-53': ['Spurrinnen'],
  '1007-54': ['Linksabbieger'],
  '1007-55': ['Skiabfahrt', 'kreuzt'],
  '1007-56': ['Skiwanderweg', 'kreuzt'],
  '1007-57': ['Kuppe'],
  '1007-58': ['Polizei-', 'kontrolle'],
  '1007-59': ['Ende', 'Seitenstreifen', 'in 200 m'],
  '1007-60': ['Seitenstreifen', 'nicht befahrbar'],
  '1007-61': ['Nebel'],
  '1007-62': ['Zufahrt'],
  '1008-31': ['Verkehrsführung', 'geändert'],
  '1008-32': ['Industriegebiet', 'Schienenfahrzeuge', 'haben Vorrang'],
  '1008-33': ['Hafengebiet', 'Schienenfahrzeuge', 'haben Vorrang'],
  '1010-70': ['Carsharing'],
  '1012-33': ['keine Mofas'],
  '1012-35': ['bei Rot', 'hier halten'],
  '1012-36': ['Lärmschutz'],
  '1012-37': ['Zufluss-', 'regelung'],
  '1012-38': ['Nebenstrecke'],
  '1012-50': ['Schule'],
  '1012-51': ['Kindergarten'],
  '1012-52': ['Altenheim'],
  '1012-53': ['Krankenhaus'],
  '1012-54': ['Seniorenheim'],
  '1013-50': ['Seitenstreifen', 'befahren'],
  '1013-51': ['Seitenstreifen', 'räumen'],
  '1020-13': ['Inline-Skaten und', 'Rollschuhfahren', 'frei'],
  '1020-14': ['Wintersport', 'frei'],
  '1020-31': ['Anlieger oder', 'Parken frei'],
  '1022-13': ['E-Bikes frei'],
  '1022-16': ['Elektrokleinst-', 'fahrzeuge frei'],
  '1024-20': ['Elektro-', 'fahrzeuge frei'],
  '1024-21': ['Carsharing-', 'fahrzeuge frei'],
  '1024-22': ['mehrfach besetzte', 'Pkw frei'],
  '1026-30': ['Taxi frei'],
  '1026-31': ['Kraftomnibusse im', 'Gelegenheits-', 'verkehr frei'],
  '1026-32': ['Linienverkehr', 'frei'],
  '1026-33': ['Einsatz-', 'fahrzeuge frei'],
  '1026-34': ['Kranken-', 'fahrzeuge frei'],
  '1026-35': ['Lieferverkehr', 'frei'],
  '1026-36': ['Landwirtschaft-', 'licher Verkehr', 'frei'],
  '1026-37': ['Forstwirtschaft-', 'licher Verkehr', 'frei'],
  '1026-38': ['Land- und forst-', 'wirtschaftlicher', 'Verkehr frei'],
  '1026-39': ['Betriebs- und', 'Versorgungsdienst', 'frei'],
  '1026-60': ['Elektrofahrzeuge', 'während des Lade-', 'vorgangs frei'],
  '1026-61': ['Elektro-', 'fahrzeuge frei'],
  '1026-62': ['Gülletransport', 'frei'],
  '1026-63': ['E-Bikes frei'],
  '1028-30': ['Baustellen-', 'fahrzeuge frei'],
  '1028-31': ['bis Baustelle', 'frei'],
  '1028-32': ['Anlieger bis', 'Baustelle frei'],
  '1028-34': ['Fährbenutzer', 'frei'],
  '1040-32': ['2 Std.'],
  '1040-33': ['Parken mit', 'Parkscheibe', '2 Std.'],
  '1042-30': ['werktags'],
  '1042-31': ['werktags', '18–19 h'],
  '1042-32': ['werktags', '8.30–11.30 h', '16–18 h'],
  '1042-34': ['Di, Do, Fr', '16–18 h'],
  '1042-35': ['6–22 h', 'an Sonn- und', 'Feiertagen'],
  '1042-36': ['Schulbus', 'Mo–Fr', '7–8.30 h, 13–16 h'],
  '1042-37': ['Parken', 'Sa und So', 'erlaubt'],
  '1042-38': ['werktags', 'außer samstags'],
  '1042-51': ['Sa und So'],
  '1042-52': ['Sa, So und', 'an Feiertagen'],
  '1044-30': ['Bewohner mit', 'Parkausweis', 'Nr. … frei'],
  '1048-14': ['nur Sattel-', 'kraftfahrzeuge'],
  '1048-15': ['nur Sattelkraft-', 'fahrzeuge und Züge'],
  '1048-18': ['nur Schienenbahn'],
  '1049-12': ['nur militärische', 'Kettenfahrzeuge'],
  '1050-30': ['Taxi'],
  '1050-32': ['Elektrofahrzeuge', 'während des', 'Ladevorgangs'],
  '1050-33': ['Elektrofahrzeuge'],
  '1052-33': ['nur mit', 'Parkschein'],
  '1052-34': ['gebühren-', 'pflichtig'],
  '1052-37': ['Haltverbot auch', 'auf dem', 'Seitenstreifen'],
  '1052-38': ['schlechter', 'Fahrbahnrand'],
  '1052-39': ['auf dem', 'Seitenstreifen'],
  '1053-30': ['Parken in', 'gekennzeichneten', 'Flächen erlaubt'],
  '1053-31': ['mit Parkschein'],
  '1053-32': ['gebühren-', 'pflichtig'],
  '1053-34': ['auf dem', 'Seitenstreifen'],
  '1053-36': ['Durchgangs-', 'verkehr'],
  '1053-38': ['Durchgangs-', 'verkehr'],
  '1053-52': ['nur innerhalb', 'gekennzeichneter', 'Parkflächen'],
  '1053-53': ['Parken mit Park-', 'schein in gekenn-', 'zeichneten Flächen'],
  '1053-54': ['während des', 'Ladevorgangs'],
  '1060-30': ['Streugut'],
  '1060-31': ['Haltverbot auch', 'auf dem', 'Seitenstreifen'],
  '1060-32': ['auch Kraftomnibusse', 'und Pkw', 'mit Anhänger'],
  '1060-34': ['Haltverbot auch', 'auf dem Seiten-', 'streifen links'],
};

/** Panels that show a value with words around it: the lines, given the value ('' where the map has none). */
const VALUED: Record<string, (v: string) => string[]> = {
  '1001-30': (v) => [`auf ${withUnit(v || '…', 'm')}`],
  '1001-31': (v) => [`auf ${withUnit(v || '…', 'km')}`],
  '1001-32': (v) => [`noch ${withUnit(v || '…', 'm')}`],
  '1001-33': (v) => [`noch ${withUnit(v || '…', 'km')}`],
  '1004-30': (v) => [withUnit(v || '100', 'm')],
  '1004-31': (v) => [withUnit(v || '…', 'km')],
  '1004-32': (v) => [withUnit(v || '200', 'm')],
  '1004-33': (v) => [withUnit(v || '400', 'm')],
  '1004-34': (v) => [withUnit(v || '600', 'm')],
  '1004-35': (v) => [withUnit(v || '2', 'km')],
  '1005-30': (v) => ['Reißverschluss', `erst in ${withUnit(v || '200', 'm')}`],
  '1005-31': (v) => [`Ende in ${withUnit(v || '…', 'm')}`],
  '1012-34': (v) => ['Grüne Welle', `bei ${v || '50'} km/h`],
  '1013-52': (v) => [`Ende in ${withUnit(v || '…', 'm')}`],
  '1020-32': (v) => ['Bewohner mit', 'Parkausweis', `Nr. ${v || '…'} frei`],
  '1028-33': (v) => ['Zufahrt bis', v || '…', 'frei'],
  '1040-34': (v) => [`ab ${v || '…'} h`],
  '1050-31': (v) => [`${v || '…'} Taxen`],
  '1052-35': (v) => [withUnit(v || '7.5', 't')],
  '1053-33': (v) => [withUnit(v || '7.5', 't')],
  '1053-37': (v) => [withUnit(v || '12', 't')],
  '1060-33': (v) => [withUnit(v || '2.8', 't')],
};

/** Panels with a pictogram (and words beside it). */
const PICTURED: Record<string, { glyph: Glyph; words?: string[]; before?: string; flip?: boolean }> = {
  '1010-50': { glyph: car },
  '1010-51': { glyph: truck },
  '1010-53': { glyph: person },
  '1010-54': { glyph: rider },
  '1010-55': { glyph: cow },
  '1010-56': { glyph: tram },
  '1010-57': { glyph: bus },
  '1010-59': { glyph: trailerCar },
  '1010-60': { glyph: trailerTruck },
  '1010-61': { glyph: tractor },
  '1010-62': { glyph: motorbike },
  '1010-63': { glyph: moped },
  '1010-64': { glyph: horse },
  '1010-65': { glyph: bike, words: ['E'] },
  '1010-66': { glyph: car, words: ['E'] },
  '1010-67': { glyph: camper },
  '1010-68': { glyph: scooter },
  '1010-69': { glyph: cargoBike },
  '1010-71': { glyph: car, words: ['2+'] },
  '1010-72': { glyph: motorbike, words: ['+ Pkw'] },
  '1020-11': { glyph: wheelchair, words: ['mit Parkausweis', 'Nr. … frei'] },
  '1022-11': { glyph: moped, words: ['frei'] },
  '1022-12': { glyph: motorbike, words: ['frei'] },
  '1022-14': { glyph: moped, words: ['und Rad', 'frei'] },
  '1022-15': { glyph: moped, words: ['und E-Bikes', 'frei'] },
  '1022-17': { glyph: cargoBike, words: ['frei'] },
  '1024-11': { glyph: trailerCar, words: ['frei'] },
  '1024-12': { glyph: truck, words: ['frei'] },
  '1024-13': { glyph: trailerTruck, words: ['frei'] },
  '1024-14': { glyph: bus, words: ['frei'] },
  '1024-15': { glyph: tram, words: ['frei'] },
  '1024-16': { glyph: tram, words: ['frei'] },
  '1024-17': { glyph: tractor, words: ['frei'] },
  '1024-18': { glyph: horse, words: ['frei'] },
  '1024-19': { glyph: camper, words: ['bis 7,5 t', 'frei'] },
  '1044-10': { glyph: wheelchair },
  '1044-11': { glyph: wheelchair, words: ['mit Parkausweis', 'Nr. …'] },
  '1044-12': { glyph: wheelchair },
  '1046-11': { glyph: moped, before: 'nur' },
  '1046-12': { glyph: motorbike, before: 'nur' },
  '1048-10': { glyph: car, before: 'nur' },
  '1048-11': { glyph: trailerCar, before: 'nur' },
  '1048-13': { glyph: trailerTruck, before: 'nur' },
  '1048-16': { glyph: bus, before: 'nur' },
  '1048-17': { glyph: camper, before: 'nur' },
  '1048-19': { glyph: tram, before: 'nur' },
  '1048-20': { glyph: trailerCar, before: 'nur', words: ['und Lkw'] },
  '1049-10': { glyph: tractor, before: 'nur' },
  '1049-11': { glyph: tractor, words: ['darf überholt', 'werden'] },
  '1049-13': { glyph: truck, before: 'nur', words: ['Bus, Pkw', 'mit Anhänger'] },
  '1052-30': { glyph: hazardPlate },
  '1052-31': { glyph: drops },
};

/** Prohibitions for one kind of road user: the red ring round a pictogram. */
const BANNED: Record<string, Glyph> = {
  '256': moped,
  '257-50': moped,
  '257-51': rider,
  '257-52': horse,
  '257-53': cow,
  '257-54': bus,
  '257-55': car,
  '257-56': trailerCar,
  '257-57': trailerTruck,
  '257-58': tractor,
  '257-59': scooter,
  '258': rider,
  '261': hazardPlate,
  '269': drops,
};

/** Danger signs with a pictogram: the triangle round it (the -20 numbers face the other way). */
const DANGER: Record<string, { glyph: Glyph; flip?: boolean }> = {
  '133-20': { glyph: person, flip: true },
  '136-20': { glyph: children, flip: true },
  '138-20': { glyph: bike, flip: true },
  '140-10': { glyph: cow },
  '140-20': { glyph: cow, flip: true },
  '142-20': { glyph: deer, flip: true },
  '144-10': { glyph: plane },
  '144-20': { glyph: plane, flip: true },
};

/** Codes drawn on a panel of 600 × 330 (one or two lines) – or taller, 600 × 450 / 600 × 600, for more lines. */
function panelLinesOf(base: string, arg: string): string[] | null {
  if (base.startsWith('1040-') || base.startsWith('1042-')) {
    if (arg) {
      const w = parseTimeWindow(arg);
      const lines = w ? windowLines(w) : [arg];
      if (base === '1040-35') return ['Lärmschutz', ...lines];
      if (base === '1040-36' || base === '1042-53') return ['Schulweg', ...lines];
      return lines;
    }
    if (base === '1040-35') return ['Lärmschutz'];
    if (base === '1040-36' || base === '1042-53') return ['Schulweg'];
  }
  const v = VALUED[base];
  if (v) return v(arg);
  return WORDS[base] ?? null;
}

/** width / height of a panel with so many lines */
const panelAspect = (lines: number): number => (lines <= 2 ? 600 / 330 : lines === 3 ? 600 / 450 : 1);

/** The width / height of the plate of a sign drawn here (null: not drawn here). */
export function artAspect(code: string): number | null {
  const [base, arg] = splitCode(code);
  const lines = panelLinesOf(base, arg);
  if (lines) return panelAspect(lines.length);
  const pic = PICTURED[base];
  if (pic) return panelAspect((pic.words?.length ?? 0) > 1 ? 3 : 1);
  if (BANNED[base] || DANGER[base]) return DANGER[base] ? 847 / 744 : 1;
  if (/^(108|110)-\d+$/.test(base) || base === '117-10' || base === '117-20') return 847 / 744;
  if (['238', '262', '263', '264', '265', '266', '268', '273', '277.1'].includes(base) || /^27[59](-\d+)?$/.test(base)) return 1;
  if (base === '270.1' || base === '270.2') return 600 / 750;
  if (/^244\.[34]$/.test(base) || /^314\.[12]$/.test(base)) return 1;
  if (/^357-5[0-2]$/.test(base) || base === '354' || base === '356' || base === '358' || base === '363' || /^365-\d+$/.test(base)) return 1;
  if (/^454-[12]0$/.test(base)) return 2;
  if (/^455\.1-\d+$/.test(base) || base === '457.1' || base === '457.2') return 1.6;
  if (/^605-\d+$/.test(base)) return 0.25;
  if (/^626-\d+$/.test(base) || base === '600') return 4;
  return null;
}

/**
 * Draw sign `code` into the rectangle (x, y, w, h) – its plate fills it –
 * and say whether this file knows it.
 */
export function drawSignArt(g: G, code: string, x: number, y: number, w: number, h: number): boolean {
  const [base, arg] = splitCode(code);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) / 2;
  g.save();
  try {
    // ---- panels with words, values, times
    const lines = panelLinesOf(base, arg);
    if (lines) {
      panel(g, x, y, w, h);
      panelLines(g, lines, x, y, w, h);
      return true;
    }
    const pic = PICTURED[base];
    if (pic) {
      panel(g, x, y, w, h);
      const words = pic.words ?? [];
      if (pic.before) {
        // "nur" and the pictogram, what else is meant beneath
        const hh = words.length > 0 ? 0.56 : 0.78;
        text(g, pic.before, x + w * 0.2, y + h * (0.1 + hh / 2), w * 0.3, h * Math.min(0.42, hh * 0.6));
        glyphIn(g, pic.glyph, x + w * 0.36, y + h * 0.1, w * 0.5, h * hh);
        if (words.length > 0) text(g, words.join(' '), cx, y + h * 0.82, w * 0.86, h * 0.2);
      } else if (words.length === 0) {
        glyphIn(g, pic.glyph, x + w * 0.15, y + h * 0.1, w * 0.7, h * 0.8, BLACK, pic.flip);
      } else if (words.length === 1 && words[0].length <= 6) {
        glyphIn(g, pic.glyph, x + w * 0.06, y + h * 0.1, w * 0.5, h * 0.8);
        text(g, words[0], x + w * 0.76, cy, w * 0.4, h * 0.36);
      } else {
        glyphIn(g, pic.glyph, x + w * 0.2, y + h * 0.06, w * 0.6, h * 0.46);
        words.forEach((t, i) => text(g, t, cx, y + h * (0.62 + (0.3 * i) / Math.max(1, words.length - 0.5)), w * 0.86, h * 0.17));
      }
      return true;
    }
    // ---- prohibitions with a pictogram
    const banned = BANNED[base];
    if (banned) {
      round(g, cx, cy, r - 1, 'ban');
      glyphIn(g, banned, cx - r * 0.62, cy - r * 0.62, r * 1.24, r * 1.24);
      return true;
    }
    const danger = DANGER[base];
    if (danger) {
      triangle(g, x, y, w, h);
      glyphIn(g, danger.glyph, x + w * 0.3, y + h * 0.36, w * 0.4, h * 0.46, BLACK, danger.flip);
      return true;
    }
    // ---- gradients (108 down, 110 up): the slope and its percentage
    const grade = /^(108|110)-(\d+)$/.exec(base);
    if (grade) {
      triangle(g, x, y, w, h);
      g.fillStyle = BLACK;
      const up = grade[1] === '110';
      g.beginPath();
      g.moveTo(x + w * 0.3, y + h * 0.78);
      g.lineTo(x + w * 0.7, y + h * 0.78);
      g.lineTo(up ? x + w * 0.7 : x + w * 0.3, y + h * 0.56);
      g.closePath();
      g.fill();
      text(g, `${grade[2]} %`, cx + (up ? -w * 0.07 : w * 0.07), y + h * 0.5, w * 0.24, h * 0.13);
      return true;
    }
    if (base === '117-10' || base === '117-20') {
      // side wind: a windsock
      triangle(g, x, y, w, h);
      g.save();
      if (base === '117-20') {
        g.translate(2 * cx, 0);
        g.scale(-1, 1);
      }
      g.fillStyle = BLACK;
      g.fillRect(x + w * 0.36, y + h * 0.42, w * 0.03, h * 0.38);
      poly(g, [x + w * 0.39, y + h * 0.43, x + w * 0.66, y + h * 0.5, x + w * 0.66, y + h * 0.56, x + w * 0.39, y + h * 0.6]);
      g.restore();
      return true;
    }
    // ---- mandatory signs and others in a ring
    if (base === '238') {
      round(g, cx, cy, r - 1, 'blue');
      glyphIn(g, rider, cx - r * 0.6, cy - r * 0.6, r * 1.2, r * 1.2, WHITE);
      return true;
    }
    if (base === '268') {
      // snow chains: a tyre with its chain
      round(g, cx, cy, r - 1, 'blue');
      g.strokeStyle = WHITE;
      g.lineWidth = r * 0.12;
      g.beginPath();
      g.arc(cx, cy, r * 0.48, 0, Math.PI * 2);
      g.stroke();
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        line(g, r * 0.06, cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3, cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
      }
      return true;
    }
    if (/^275(-\d+)?$/.test(base) || /^279(-\d+)?$/.test(base)) {
      // minimum speed (and its end)
      round(g, cx, cy, r - 1, 'blue');
      text(g, arg || base.split('-')[1] || '30', cx, cy + r * 0.04, r * 1.3, r * 0.9, WHITE);
      if (base.startsWith('279')) {
        g.strokeStyle = RED;
        line(g, r * 0.14, cx - r * 0.66, cy + r * 0.66, cx + r * 0.66, cy - r * 0.66);
      }
      return true;
    }
    if (['262', '263', '264', '265', '266'].includes(base)) {
      round(g, cx, cy, r - 1, 'ban');
      const unit = base === '262' || base === '263' ? 't' : 'm';
      const v = withUnit(arg || '…', unit);
      g.fillStyle = BLACK;
      if (base === '264') {
        // the width between two arrowheads
        poly(g, [cx - r * 0.62, cy, cx - r * 0.42, cy - r * 0.16, cx - r * 0.42, cy + r * 0.16]);
        poly(g, [cx + r * 0.62, cy, cx + r * 0.42, cy - r * 0.16, cx + r * 0.42, cy + r * 0.16]);
        text(g, v, cx, cy, r * 0.8, r * 0.42);
      } else if (base === '265') {
        poly(g, [cx, cy - r * 0.64, cx - r * 0.18, cy - r * 0.42, cx + r * 0.18, cy - r * 0.42]);
        poly(g, [cx, cy + r * 0.64, cx - r * 0.18, cy + r * 0.42, cx + r * 0.18, cy + r * 0.42]);
        text(g, v, cx, cy, r * 1.1, r * 0.42);
      } else if (base === '266') {
        glyphIn(g, truck, cx - r * 0.5, cy - r * 0.62, r, r * 0.7);
        text(g, v, cx, cy + r * 0.35, r * 1.1, r * 0.36);
      } else if (base === '263') {
        text(g, v, cx, cy - r * 0.12, r * 1.1, r * 0.42);
        // the axle beneath
        g.fillRect(cx - r * 0.45, cy + r * 0.28, r * 0.9, r * 0.08);
        wheel(g, cx - r * 0.38, cy + r * 0.38, r * 0.12);
        wheel(g, cx + r * 0.38, cy + r * 0.38, r * 0.12);
      } else text(g, v, cx, cy, r * 1.2, r * 0.5);
      return true;
    }
    if (base === '273') {
      // keep the distance: two cars and the metres between them
      round(g, cx, cy, r - 1, 'ban');
      glyphIn(g, car, cx - r * 0.66, cy - r * 0.46, r * 0.56, r * 0.5);
      glyphIn(g, car, cx + r * 0.1, cy - r * 0.46, r * 0.56, r * 0.5);
      text(g, `${arg || '70'} m`, cx, cy + r * 0.3, r * 1.0, r * 0.36);
      return true;
    }
    if (base === '277.1') {
      // no overtaking of single-track vehicles
      round(g, cx, cy, r - 1, 'ban');
      glyphIn(g, motorbike, cx - r * 0.66, cy - r * 0.4, r * 0.62, r * 0.62);
      glyphIn(g, car, cx + r * 0.02, cy - r * 0.4, r * 0.64, r * 0.62, RED);
      return true;
    }
    if (base === '270.1' || base === '270.2') {
      // the environmental zone: a panel with the ring and "Umwelt", "ZONE" beneath
      panel(g, x, y, w, h);
      const rr = w * 0.32;
      round(g, cx, y + h * 0.36, rr, 'ban');
      text(g, 'Umwelt', cx, y + h * 0.36, rr * 1.4, rr * 0.4);
      text(g, 'ZONE', cx, y + h * 0.8, w * 0.7, h * 0.14);
      if (base === '270.2') {
        g.strokeStyle = 'rgba(17,17,17,0.85)';
        line(g, w * 0.05, x + w * 0.1, y + h * 0.92, x + w * 0.9, y + h * 0.08);
      }
      return true;
    }
    // ---- zones and guidance
    const zone = /^(244|314)\.([1-4])$/.exec(base);
    if (zone) {
      panel(g, x, y, w, h);
      if (zone[1] === '244') {
        const rr = w * 0.3;
        round(g, cx, y + h * 0.4, rr, 'blue');
        glyphIn(g, bike, cx - rr * 0.7, y + h * 0.4 - rr * 0.7, rr * 1.4, rr * 1.4, WHITE);
      } else {
        blueSquare(g, x + w * 0.24, y + h * 0.1, w * 0.52, h * 0.52);
        text(g, 'P', cx, y + h * 0.37, w * 0.4, h * 0.4, WHITE);
      }
      text(g, 'ZONE', cx, y + h * 0.82, w * 0.7, h * 0.18);
      const ends = zone[1] === '244' ? zone[2] === '4' : zone[2] === '2';
      if (ends) {
        g.strokeStyle = 'rgba(17,17,17,0.85)';
        line(g, w * 0.05, x + w * 0.1, y + h * 0.92, x + w * 0.9, y + h * 0.08);
      }
      return true;
    }
    const deadEnd = /^357-5([0-2])$/.exec(base);
    if (deadEnd) {
      // a dead end, open for cyclists (-50), people on foot (-51) or both (-52)
      blueSquare(g, x, y, w, h);
      g.fillStyle = WHITE;
      g.fillRect(x + w * 0.42, y + h * 0.36, w * 0.16, h * 0.54);
      g.fillStyle = RED;
      g.fillRect(x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.16);
      const k = deadEnd[1];
      if (k !== '1') glyphIn(g, bike, x + w * 0.04, y + h * 0.04, w * 0.3, h * 0.3, WHITE);
      if (k !== '0') glyphIn(g, person, x + w * 0.66, y + h * 0.02, w * 0.3, h * 0.3, WHITE);
      return true;
    }
    if (base === '354') {
      // water protection area: waves on white
      blueSquare(g, x, y, w, h);
      g.fillStyle = WHITE;
      g.fillRect(x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68);
      g.strokeStyle = BLUE;
      for (let k = 0; k < 3; k++) {
        g.lineWidth = h * 0.05;
        g.beginPath();
        const yy = y + h * (0.38 + k * 0.14);
        g.moveTo(x + w * 0.22, yy);
        for (let i = 1; i <= 4; i++) g.quadraticCurveTo(x + w * (0.22 + (i - 0.5) * 0.14), yy + (i % 2 ? -1 : 1) * h * 0.07, x + w * (0.22 + i * 0.14), yy);
        g.stroke();
      }
      return true;
    }
    if (base === '356' || base === '358' || base === '363' || /^365-\d+$/.test(base)) {
      // a service sign: blue with a white square
      blueSquare(g, x, y, w, h);
      g.fillStyle = WHITE;
      g.fillRect(x + w * 0.16, y + h * 0.16, w * 0.68, h * 0.68);
      if (base === '358') {
        g.fillStyle = RED;
        g.fillRect(x + w * 0.42, y + h * 0.24, w * 0.16, h * 0.52);
        g.fillRect(x + w * 0.24, y + h * 0.42, w * 0.52, h * 0.16);
      } else if (base === '363') text(g, 'POLIZEI', cx, cy, w * 0.6, h * 0.16);
      else if (base === '356') glyphIn(g, person, x + w * 0.22, y + h * 0.2, w * 0.56, h * 0.6);
      else glyphIn(g, car, x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6);
      return true;
    }
    // ---- detours: yellow boards
    const detour = /^454-([12])0$/.exec(base);
    if (detour) {
      yellowBoard(g, x, y, w, h);
      const left = detour[1] === '1';
      arrow(g, left ? x + w * 0.24 : x + w * 0.76, cy, h * 0.7, left ? -Math.PI / 2 : Math.PI / 2, BLACK);
      text(g, 'U', left ? x + w * 0.66 : x + w * 0.34, cy, w * 0.3, h * 0.6);
      return true;
    }
    const announce = /^455\.1-(\d)(\d)$/.exec(base);
    if (announce || base === '457.1' || base === '457.2') {
      yellowBoard(g, x, y, w, h);
      text(g, base === '457.2' ? 'Ende der' : 'Umleitung', cx, y + h * (base === '457.2' ? 0.32 : 0.3), w * 0.84, h * 0.24);
      if (base === '457.2') text(g, 'Umleitung', cx, y + h * 0.66, w * 0.84, h * 0.24);
      else if (announce) {
        const d = announce[1];
        const angle = d === '1' ? -Math.PI / 2 : d === '2' ? Math.PI / 2 : 0;
        arrow(g, cx, y + h * 0.7, h * 0.42, angle, BLACK);
      } else text(g, '→', cx, y + h * 0.7, w * 0.6, h * 0.3);
      return true;
    }
    // ---- beacons and barriers
    // (the stripes fall towards the side traffic passes: -1x to the left, -2x to the right)
    const beacon = /^605-(\d)\d*$/.exec(base);
    if (beacon) {
      stripes(g, x, y, w, h, beacon[1] === '1' ? -1 : 1, 7);
      return true;
    }
    const plate = /^626-(\d)\d*$/.exec(base);
    if (plate || base === '600') {
      stripes(g, x, y, w, h, plate && plate[1] === '1' ? -1 : 1, 9);
      return true;
    }
    return false;
  } catch {
    // (a canvas that cannot do something: the simple drawing of render/signs.ts instead)
    return false;
  } finally {
    g.restore();
  }
}

