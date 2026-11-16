// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The rule behind each fault the instructor reports: the citation of the
 * German road traffic regulations (StVO), the same in every language.
 * An entry starting with "@" is a text key (where there is no paragraph).
 * Title and explanation are texts: "v.<id>.title", "v.<id>.why".
 */
export const VIOLATION_REFS: Record<string, string> = {
  speed: '§ 3 StVO, Zeichen 274',
  speedWalk: 'Anlage 3 StVO, Zeichen 325.1',
  redLight: '§ 37 Abs. 2 StVO',
  stopLine: 'Anlage 2 StVO, Zeichen 294; § 37 Abs. 2 StVO',
  amberLight: '§ 37 Abs. 2 StVO',
  stopSign: 'Anlage 2 StVO, Zeichen 206',
  prioritySign: '§ 8 Abs. 2 StVO, Zeichen 205/206',
  rightBeforeLeft: '§ 8 Abs. 1 StVO',
  priorityRoundabout: '§ 8 Abs. 1a StVO',
  priorityDriveway: '§ 10 StVO',
  leftTurnOncoming: '§ 9 Abs. 3 StVO',
  cutOff: '§ 1 Abs. 2, § 7 Abs. 5, § 10 StVO',
  zebra: '§ 26 Abs. 1 StVO, Zeichen 350',
  zebraSpeed: '§ 26 Abs. 1 StVO',
  pedestrian: '§ 1 Abs. 2, § 3 Abs. 2a StVO',
  cyclistCutOff: '§ 9 Abs. 3 StVO',
  doorCheck: '§ 14 Abs. 1 StVO',
  // the tram: the regulation for trams (BOStrab) – § 50 the speeds, § 54 operation: doors closed before
  // departing (Abs. 1), opened only at stops and only once stopped (Abs. 2)
  tramCurve: '§ 50 BOStrab',
  tramStopMissed: '§ 54 Abs. 2 BOStrab',
  tramStopPlace: '§ 54 Abs. 2 BOStrab',
  tramDoorsMoving: '§ 54 Abs. 1 BOStrab',
  tramDoorsEarly: '§ 54 Abs. 1 BOStrab',
  // the pantograph: the operating rules of the company (no paragraph of the BOStrab of its own)
  tramPantoLoad: '@ref.tramRules',
  tramPantoWireEnd: '@ref.tramRules',
  // on foot: the pavement (§ 25 Abs. 1), across the road straight and with an eye on the traffic – at a crossing
  // near by (§ 25 Abs. 3) –, the pedestrians' lights (§ 37 Abs. 2 Nr. 5)
  pedRed: '§ 37 Abs. 2 Nr. 5 StVO',
  pedRoad: '§ 25 Abs. 1 StVO',
  pedCrossing: '§ 25 Abs. 3 StVO',
  pedForcedBrake: '§ 25 Abs. 3 StVO',
  pedHit: '§ 25 Abs. 3 StVO',
  // the bus on a line: the stops are the company's to serve (no paragraph of its own); pulling out of the stop is § 10 StVO
  busStopMissed: '@ref.busService',
  busStopPlace: '@ref.busService',
  busDoorsMoving: '@ref.busService',
  busDoorsEarly: '@ref.busService',
  busPullOut: '§ 10 StVO',
  classSpeed: '§ 3 Abs. 3, § 18 Abs. 5 StVO',
  motorwayBan: '§ 18 Abs. 1 StVO',
  doorTraffic: '§ 14 Abs. 1 StVO',
  notSecured: '§ 14 Abs. 2 StVO',
  preCheck: '§ 23 Abs. 1 StVO',
  cyclistHit: '§ 1 Abs. 2, § 9 Abs. 3 StVO',
  noIndicator: '§ 9 Abs. 1 StVO',
  wrongIndicator: '§ 9 Abs. 1 StVO',
  indicatorLeftOn: '§ 9 Abs. 1 StVO',
  noShoulderCheck: '§ 9 Abs. 1, Abs. 3 StVO',
  roundaboutEntryIndicator: '§ 8 Abs. 1a StVO',
  roundaboutExitIndicator: '§ 8 Abs. 1a, § 9 Abs. 1 StVO',
  turnBan: 'Anlage 2 StVO, Zeichen 209–214',
  wrongWay: 'Anlage 2 StVO, Zeichen 220, 267',
  keepRight: '§ 2 Abs. 2 StVO',
  sidewalk: '§ 2 Abs. 1 StVO',
  offRoad: '§ 2 Abs. 1 StVO',
  accessPrivate: 'Anlage 2 StVO, Zeichen 250',
  accessAgricultural: 'Anlage 2 StVO, Zeichen 250/260',
  accessDestination: 'Zusatzzeichen 1020-30',
  distance: '§ 4 Abs. 1 StVO',
  crash: '§ 1 Abs. 2 StVO',
  crashObject: '§ 3 Abs. 1 StVO',
  // class CE: the tasks of the practical test, and what the StVO asks of trucks
  ceLine: 'Anlage 7 FeV, Nr. 2.1.4.5',
  ceCorrections: 'Anlage 7 FeV, Nr. 2.1.4.5',
  ceRamp: 'Anlage 7 FeV, Nr. 2.1.4.5',
  ceSecure: 'Anlage 7 FeV, Nr. 2.1.3',
  ceAir: 'Anlage 7 FeV, Nr. 2.1.3',
  ceOpen: 'Anlage 7 FeV, Nr. 2.1.3',
  ceLocked: 'Anlage 7 FeV, Nr. 2.1.3',
  ceRelease: 'Anlage 7 FeV, Nr. 2.1.3',
  ceLights: 'Anlage 7 FeV, Nr. 2.1.3',
  ceHeight: 'Anlage 7 FeV, Nr. 2.1.3',
  ceFast: 'Anlage 7 FeV, Nr. 2.1.3',
  truckRightTurn: '§ 9 Abs. 6 StVO',
  truckSpeed: '§ 3 Abs. 3, § 18 Abs. 5 StVO',
  stall: '@ref.vehicle',
  seatbelt: '§ 21a Abs. 1 StVO',
  handbrakeOn: '@ref.vehicle',
};

/** Where the regulations can be read: the official collection of federal law (gesetze-im-internet.de). */
const STVO_URL = 'https://www.gesetze-im-internet.de/stvo_2013/';
const BOSTRAB_URL = 'https://www.gesetze-im-internet.de/strabbo_1987/';
const FEV_URL = 'https://www.gesetze-im-internet.de/fev_2010/';

export interface CitationPart {
  text: string;
  /** the page of the paragraph or annex this part cites */
  url?: string;
}

/**
 * A citation cut into pieces, each paragraph ("§ 8 Abs. 1a") and annex
 * ("Anlage 2") with the address of its text:
 * "§ 1 Abs. 2, § 7 Abs. 5 StVO" → [§ 1 Abs. 2 → …/__1.html] ", " [§ 7 Abs. 5 → …/__7.html] " StVO".
 */
export function citationParts(ref: string): CitationPart[] {
  const parts: CitationPart[] = [];
  // (an annex belongs to the regulation named behind it: the StVO or the driving-licence regulation FeV)
  const re = /§ (\d+[a-z]?)(?: Abs\. \d+[a-z]?(?:, Abs\. \d+[a-z]?)*)?|Anlage (\d+)(?= (StVO|FeV))/g;
  let last = 0;
  for (const m of ref.matchAll(re)) {
    if (m.index > last) parts.push({ text: ref.slice(last, m.index) });
    // (a paragraph belongs to the law named after it: the StVO, or the tram regulation BOStrab)
    const law = m[1] ? (/\b(StVO|FeV|BOStrab)\b/.exec(ref.slice(m.index))?.[1] ?? 'StVO') : '';
    parts.push({ text: m[0], url: m[1] ? `${law === 'BOStrab' ? BOSTRAB_URL : STVO_URL}__${m[1]}.html` : `${m[3] === 'FeV' ? FEV_URL : STVO_URL}anlage_${m[2]}.html` });
    last = m.index + m[0].length;
  }
  if (last < ref.length) parts.push({ text: ref.slice(last) });
  return parts;
}
