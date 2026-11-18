// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "Spot the danger": a moment of each theory scene (game/theory.ts,
 * theoryscenes.ts, theorycrossing.ts), frozen and seen from above – why must
 * you be ready to brake here?  Two to four answers, one or more of them
 * right.  The moment is the time of one of the scene's questions (`step`)
 * moved by `off` seconds, so that it follows the scene when its script is
 * changed.  The words are in src/i18n/exam/<lang>.ts under `danger`.
 */

export interface DangerItem {
  /** its id (the scene's id: one item per scene) */
  id: string;
  /** the theory scene */
  scene: string;
  /** the moment: the time of this question of the scene (index), moved by `off` s */
  step: number;
  off: number;
  answers: number;
  correct: number[];
  ref: string;
}

export const DANGER_ITEMS: readonly DangerItem[] = [
  { id: "rbl", scene: "rbl", step: 0, off: -1.0, answers: 3, correct: [0, 1], ref: "§ 8 Abs. 1 StVO" },
  { id: "bend", scene: "bend", step: 1, off: -0.5, answers: 3, correct: [0, 1], ref: "Anlage 3 StVO, Zeichen 306" },
  { id: "leftTurn", scene: "leftTurn", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 9 Abs. 3 StVO" },
  { id: "zebra", scene: "zebra", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 26 Abs. 1 StVO" },
  { id: "tram", scene: "tram", step: 0, off: -0.8, answers: 3, correct: [0, 1], ref: "§ 9 Abs. 3 StVO" },
  { id: "corridor", scene: "corridor", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 11 Abs. 2 StVO" },
  { id: "schoolBus", scene: "schoolBus", step: 1, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 20 Abs. 4 StVO" },
  { id: "overtake", scene: "overtake", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 5 Abs. 2, Abs. 4 StVO" },
  { id: "blindSpot", scene: "blindSpot", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 9 Abs. 3 StVO" },
  { id: "zip", scene: "zip", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 7 Abs. 4 StVO" },
  { id: "motorway", scene: "motorway", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 18 Abs. 3 StVO" },
  { id: "roundabout", scene: "roundabout", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 8 Abs. 1a StVO" },
  { id: "greenArrow", scene: "greenArrow", step: 1, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 37 Abs. 2 Nr. 1 StVO" },
  { id: "parkingSigns", scene: "parkingSigns", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "Anlage 2 StVO, Zeichen 283" },
  { id: "followingDistance", scene: "followingDistance", step: 1, off: -0.3, answers: 3, correct: [0, 1], ref: "§ 4 Abs. 1 StVO" },
  { id: "narrowPass", scene: "narrowPass", step: 1, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 6 StVO" },
  { id: "busStopPullOut", scene: "busStopPullOut", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 20 Abs. 4, Abs. 5 StVO" },
  { id: "nightDrive", scene: "nightDrive", step: 1, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 3 Abs. 1 StVO" },
  { id: "fogWall", scene: "fogWall", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 3 Abs. 1, § 17 Abs. 3 StVO" },
  { id: "accidentScene", scene: "accidentScene", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 16 Abs. 2 StVO, § 323c StGB" },
  { id: "truckBlindSpot", scene: "truckBlindSpot", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 9 Abs. 3 StVO" },
  { id: "multiLane", scene: "multiLane", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 7 Abs. 5 StVO" },
  { id: "tunnel", scene: "tunnel", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "Anlage 3 StVO, Zeichen 327" },
  { id: "seniorCrossing", scene: "seniorCrossing", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 3 Abs. 2a StVO" },
  { id: "wildlife", scene: "wildlife", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "Anlage 1 StVO, Zeichen 142" },
  { id: "policeSignals", scene: "policeSignals", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 36 Abs. 1 StVO" },
  { id: "flagman", scene: "flagman", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 45 Abs. 6, § 1 Abs. 2 StVO" },
  { id: "levelCrossing", scene: "levelCrossing", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 19 Abs. 1, Abs. 2 StVO" },
  { id: "levelCrossingQueue", scene: "levelCrossingQueue", step: 0, off: -0.5, answers: 3, correct: [0, 1], ref: "§ 19 Abs. 3 StVO" },
];
