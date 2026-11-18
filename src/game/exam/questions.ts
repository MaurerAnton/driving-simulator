// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The question bank of the theory exam (game/exam/exam.ts) – a starter bank
 * written for this game from the rules themselves (StVO, StVG, FeV,
 * StVZO), never copied from the official catalogue of exam questions or from
 * any app: that catalogue is copyrighted.
 *
 * This file holds what is the same in every language: each question's id,
 * its topic, its points (2 to 5, as in the real test), how many answers it
 * has and which of them are right (one or more) – or the number to type –,
 * the paragraph it rests on, and its picture (a sign drawn by the game, or a
 * frozen moment of a theory scene seen from above).  The words – question,
 * answers, explanation – are in src/i18n/exam/<lang>.ts under the same id,
 * the answers in the same order.
 *
 * Topics: danger lessons, behaviour, priority, signs, overtaking, parking,
 * lights, alcohol and fitness, environment – the basic material – and speed
 * and distance, vehicle technique, class B: the material of the class.
 * tests/game/exam.test.ts checks that every id is unique, every question has
 * a right answer, texts and a reference.
 */

export type ExamTopic = 'danger' | 'behaviour' | 'priority' | 'signs' | 'overtaking' | 'parking' | 'lights' | 'alcohol' | 'environment' | 'speed' | 'technique' | 'classB';

/** All topics, in the order of the lists. */
export const EXAM_TOPICS: readonly ExamTopic[] = ['danger', 'behaviour', 'priority', 'signs', 'overtaking', 'parking', 'lights', 'alcohol', 'environment', 'speed', 'technique', 'classB'];

/** The topics of the class-specific part (class B); all others are the basic material. */
export const CLASS_TOPICS: readonly ExamTopic[] = ['speed', 'technique', 'classB'];

/** A picture beside the question: a sign (its catalogue number), or a moment of a theory scene (the time of one of its questions). */
export type ExamPicture = { sign: string } | { scene: string; step: number; off?: number };

export interface ExamQuestion {
  id: string;
  topic: ExamTopic;
  points: 2 | 3 | 4 | 5;
  /** how many answers to choose from (0: a number is typed) */
  answers: number;
  /** the right answers (indices) – all of them must be ticked, and none else */
  correct: number[];
  /** a number to type instead: its value and unit */
  number?: { value: number; unit: string };
  /** the rule (the same in every language) */
  ref: string;
  picture?: ExamPicture;
}

/** a question with answers to tick */
function pick(id: string, topic: ExamTopic, points: ExamQuestion['points'], answers: number, correct: number[], ref: string, picture?: ExamPicture): ExamQuestion {
  return picture ? { id, topic, points, answers, correct, ref, picture } : { id, topic, points, answers, correct, ref };
}

/** a question answered with a number */
function num(id: string, topic: ExamTopic, points: ExamQuestion['points'], value: number, unit: string, ref: string, picture?: ExamPicture): ExamQuestion {
  const q: ExamQuestion = { id, topic, points, answers: 0, correct: [], number: { value, unit }, ref };
  if (picture) q.picture = picture;
  return q;
}

export const QUESTIONS: readonly ExamQuestion[] = [
  pick("dan01", "danger", 5, 3, [0, 2], "§ 3 Abs. 2a StVO"),
  pick("dan02", "danger", 4, 3, [0, 2], "§ 3 Abs. 2a StVO"),
  pick("dan03", "danger", 4, 3, [0, 1], "§ 3 Abs. 1 StVO"),
  pick("dan04", "danger", 4, 3, [0], "§ 3 Abs. 1 StVO"),
  pick("dan05", "danger", 4, 3, [0, 2], "§ 3 Abs. 1 StVO"),
  pick("dan06", "danger", 4, 3, [0, 2], "§ 1 Abs. 2 StVO"),
  pick("dan07", "danger", 5, 3, [0, 2], "§ 3 Abs. 2a StVO"),
  pick("dan08", "danger", 4, 3, [0], "§ 3 Abs. 1 StVO"),
  pick("dan09", "danger", 4, 3, [0, 1], "Anlage 1 StVO, Zeichen 142"),
  pick("dan10", "danger", 4, 3, [0, 1], "§ 1 Abs. 2 StVO"),
  pick("dan11", "danger", 5, 3, [0, 2], "§ 14 Abs. 1 StVO"),
  pick("dan12", "danger", 4, 3, [0, 2], "§ 3 Abs. 1 StVO"),
  pick("dan13", "danger", 4, 3, [0, 1], "§ 9 Abs. 3 StVO"),
  pick("dan14", "danger", 5, 3, [0, 1], "§ 3 Abs. 2a StVO"),
  pick("dan15", "danger", 4, 3, [0, 1], "§ 3 Abs. 1, § 17 Abs. 3 StVO"),
  pick("dan16", "danger", 5, 3, [0], "§ 8 Abs. 1 StVO", { scene: "rbl", step: 0 }),
  pick("beh01", "behaviour", 4, 3, [0, 2], "§ 38 Abs. 1 StVO"),
  pick("beh02", "behaviour", 5, 3, [0], "§ 11 Abs. 2 StVO"),
  pick("beh03", "behaviour", 4, 3, [0], "§ 7 Abs. 4 StVO"),
  pick("beh04", "behaviour", 4, 3, [0], "§ 2 Abs. 2 StVO"),
  pick("beh05", "behaviour", 5, 3, [0], "§ 9 Abs. 3 StVO"),
  pick("beh06", "behaviour", 4, 3, [0, 1], "§ 9 Abs. 5 StVO"),
  pick("beh07", "behaviour", 4, 3, [0], "§ 23 Abs. 1a StVO"),
  pick("beh08", "behaviour", 5, 3, [0, 1], "§ 323c StGB"),
  pick("beh09", "behaviour", 4, 3, [0, 1], "§ 34 Abs. 1 Nr. 6 StVO, § 142 StGB"),
  pick("beh10", "behaviour", 3, 3, [0, 1], "§ 16 Abs. 1 StVO"),
  pick("beh11", "behaviour", 4, 3, [0, 1, 2], "§ 7 Abs. 5 StVO"),
  pick("beh12", "behaviour", 5, 3, [0], "§ 18 Abs. 7 StVO"),
  pick("beh13", "behaviour", 4, 3, [0], "§ 18 Abs. 3 StVO"),
  pick("beh14", "behaviour", 4, 3, [0], "§ 21 Abs. 1a StVO"),
  pick("beh15", "behaviour", 3, 3, [0], "§ 8 Abs. 1a, § 9 Abs. 1 StVO"),
  pick("beh16", "behaviour", 4, 3, [0, 1], "§ 20 Abs. 4 StVO"),
  pick("pri01", "priority", 5, 3, [0], "§ 8 Abs. 1 StVO"),
  pick("pri02", "priority", 4, 3, [0], "Anlage 2 StVO, Zeichen 205", { sign: "205" }),
  pick("pri03", "priority", 5, 3, [0, 1], "Anlage 2 StVO, Zeichen 206", { sign: "206" }),
  pick("pri04", "priority", 4, 3, [0], "Anlage 3 StVO, Zeichen 301", { sign: "301" }),
  pick("pri05", "priority", 4, 3, [0, 1], "Anlage 3 StVO, Zeichen 306", { sign: "306" }),
  pick("pri06", "priority", 5, 3, [0], "§ 36 Abs. 1, Abs. 2 StVO"),
  pick("pri07", "priority", 5, 3, [0], "§ 9 Abs. 3 StVO"),
  pick("pri08", "priority", 4, 3, [0], "§ 9 Abs. 4 StVO"),
  pick("pri09", "priority", 5, 3, [0], "§ 10 StVO"),
  pick("pri10", "priority", 4, 2, [0], "§ 9 Abs. 3 StVO"),
  pick("pri11", "priority", 4, 2, [0], "§ 8 Abs. 1a StVO, Anlage 2 StVO, Zeichen 215", { sign: "215" }),
  pick("pri12", "priority", 5, 3, [0], "§ 37 Abs. 2 Nr. 1 StVO", { sign: "720" }),
  pick("pri13", "priority", 4, 3, [0, 1], "Anlage 3 StVO, Zeichen 306 mit Zusatzzeichen", { sign: "1002-10" }),
  pick("pri14", "priority", 4, 2, [0], "Anlage 2 StVO, Zeichen 208", { sign: "208" }),
  pick("sig01", "signs", 3, 3, [0], "Anlage 2 StVO, Zeichen 274", { sign: "274-50" }),
  pick("sig02", "signs", 4, 3, [0, 2], "Anlage 2 StVO, Zeichen 276", { sign: "276" }),
  pick("sig03", "signs", 3, 2, [0], "Anlage 2 StVO, Zeichen 283", { sign: "283" }),
  pick("sig04", "signs", 3, 3, [0, 1], "Anlage 2 StVO, Zeichen 286", { sign: "286" }),
  pick("sig05", "signs", 3, 2, [0], "Anlage 2 StVO, Zeichen 267", { sign: "267" }),
  pick("sig06", "signs", 4, 3, [0, 1, 2], "Anlage 3 StVO, Zeichen 325.1", { sign: "325.1" }),
  pick("sig07", "signs", 3, 2, [0], "§ 45 Abs. 1c StVO, Anlage 2 StVO, Zeichen 274.1", { sign: "274.1" }),
  pick("sig08", "signs", 3, 2, [0], "Anlage 1 StVO, Zeichen 151", { sign: "151" }),
  pick("sig09", "signs", 3, 2, [0], "Anlage 1 StVO, Zeichen 136", { sign: "136-10" }),
  pick("sig10", "signs", 3, 3, [0], "Anlage 2 StVO, Zeichen 239", { sign: "239" }),
  pick("sig11", "signs", 3, 2, [0], "Anlage 2 StVO, Zeichen 237", { sign: "237" }),
  pick("sig12", "signs", 4, 3, [0], "Anlage 2 StVO, Zeichen 224 (Ge- oder Verbot)", { sign: "224" }),
  pick("sig13", "signs", 3, 3, [0], "Anlage 3 StVO, Zeichen 330.1, § 18 Abs. 1 StVO", { sign: "330.1" }),
  pick("sig14", "signs", 3, 2, [0], "Anlage 2 StVO, Zeichen 282", { sign: "282" }),
  pick("sig15", "signs", 3, 2, [0], "Anlage 2 StVO, Zeichen 274 mit Zusatzzeichen 1052-36", { sign: "1052-36" }),
  pick("sig16", "signs", 4, 3, [0], "Anlage 2 StVO, Zeichen 250, Zusatzzeichen 1020-30", { sign: "1020-30" }),
  pick("sig17", "signs", 3, 2, [0], "Anlage 3 StVO, Zeichen 357", { sign: "357" }),
  pick("spd01", "speed", 4, 3, [0], "§ 3 Abs. 3 StVO"),
  pick("spd02", "speed", 4, 3, [0], "§ 3 Abs. 3 StVO"),
  pick("spd03", "speed", 3, 3, [0], "Autobahn-Richtgeschwindigkeits-Verordnung"),
  pick("spd04", "speed", 5, 3, [0], "§ 3 Abs. 3 Nr. 2 StVO"),
  num("spd05", "speed", 4, 50, "km/h", "§ 3 Abs. 4 StVO"),
  num("spd06", "speed", 3, 15, "m", "§ 3 Abs. 1 StVO (Faustformel)"),
  num("spd07", "speed", 3, 25, "m", "§ 3 Abs. 1 StVO (Faustformel)"),
  num("spd08", "speed", 4, 130, "m", "§ 3 Abs. 1 StVO (Faustformel)"),
  pick("spd09", "speed", 4, 3, [0], "§ 3 Abs. 1 StVO"),
  num("spd10", "speed", 4, 40, "m", "§ 4 Abs. 1 StVO"),
  num("spd11", "speed", 4, 50, "km/h", "§ 3 Abs. 1 Satz 3 StVO"),
  pick("spd12", "speed", 4, 3, [0, 1], "§ 3 Abs. 1 StVO"),
  pick("spd13", "speed", 3, 2, [0], "§ 3 Abs. 2 StVO"),
  pick("spd14", "speed", 5, 3, [0, 1], "§ 26 Abs. 1 StVO", { sign: "350" }),
  pick("ovt01", "overtaking", 4, 3, [0], "§ 5 Abs. 1 StVO"),
  pick("ovt02", "overtaking", 5, 3, [0, 2], "§ 5 Abs. 2, Abs. 3 StVO"),
  num("ovt03", "overtaking", 4, 1.5, "m", "§ 5 Abs. 4 StVO"),
  num("ovt04", "overtaking", 4, 2, "m", "§ 5 Abs. 4 StVO"),
  pick("ovt05", "overtaking", 5, 2, [0], "§ 5 Abs. 6 StVO"),
  pick("ovt06", "overtaking", 4, 3, [0, 1], "§ 5 Abs. 7 Satz 1, § 7 Abs. 3 StVO"),
  pick("ovt07", "overtaking", 4, 2, [0], "§ 19 Abs. 1 Satz 3 StVO"),
  pick("ovt08", "overtaking", 4, 3, [0, 1], "§ 5 Abs. 4, Abs. 4a StVO"),
  pick("ovt09", "overtaking", 4, 2, [0], "§ 5 Abs. 7 Satz 2 bis 4 StVO"),
  pick("ovt10", "overtaking", 5, 2, [0], "§ 26 Abs. 3 StVO"),
  pick("prk01", "parking", 3, 3, [0, 1], "§ 12 Abs. 2 StVO"),
  num("prk02", "parking", 4, 5, "m", "§ 12 Abs. 3 Nr. 1 StVO"),
  pick("prk03", "parking", 4, 3, [0, 1], "§ 12 Abs. 1 Nr. 1, Anlage 2 StVO, Zeichen 293"),
  pick("prk04", "parking", 3, 2, [0], "§ 12 Abs. 4 StVO"),
  pick("prk05", "parking", 3, 2, [0], "§ 12 Abs. 3 Nr. 3 StVO"),
  pick("prk06", "parking", 4, 2, [0, 1], "§ 37 Abs. 1 StVO, Anlage 2 StVO, Zeichen 205, 206"),
  pick("prk07", "parking", 3, 3, [0], "§ 13 Abs. 2 Nr. 2 StVO"),
  pick("prk08", "parking", 4, 3, [0, 1], "§ 14 Abs. 2 StVO"),
  pick("prk09", "parking", 3, 2, [0], "§ 12 Abs. 4, Abs. 4a StVO, Anlage 3 StVO, Zeichen 315", { sign: "315" }),
  pick("prk10", "parking", 4, 2, [0], "Anlage 3 StVO, Zeichen 314", { sign: "314" }),
  pick("lgt01", "lights", 3, 3, [0], "Anlage 3 StVO, Zeichen 327", { sign: "327" }),
  pick("lgt02", "lights", 4, 3, [0], "§ 17 Abs. 3 Satz 5 StVO"),
  pick("lgt03", "lights", 3, 2, [0], "§ 17 Abs. 2 StVO"),
  pick("lgt04", "lights", 3, 2, [0], "§ 17 Abs. 3 StVO"),
  pick("lgt05", "lights", 4, 3, [0, 1], "§ 15, § 15a Abs. 3, § 16 Abs. 2 StVO"),
  pick("lgt06", "lights", 3, 2, [0], "§ 17 Abs. 2 StVO"),
  pick("lgt07", "lights", 3, 3, [0, 1], "§ 16 Abs. 1 Nr. 1 StVO"),
  pick("lgt08", "lights", 4, 2, [0], "§ 17 Abs. 4 StVO"),
  pick("lgt09", "lights", 3, 2, [0], "§ 17 Abs. 1 StVO, Anlage 3 StVO, Zeichen 327"),
  pick("lgt10", "lights", 3, 2, [0], "§ 17 Abs. 3 StVO"),
  pick("alc01", "alcohol", 5, 3, [0], "§ 24c Abs. 1 StVG"),
  num("alc02", "alcohol", 5, 0.5, "‰", "§ 24a Abs. 1 StVG"),
  pick("alc03", "alcohol", 5, 2, [0], "§ 316 StGB"),
  pick("alc04", "alcohol", 4, 3, [0], "§ 316 StGB"),
  pick("alc05", "alcohol", 4, 2, [0], "§ 316 StGB, § 24a Abs. 2 StVG, § 2 Abs. 1 FeV"),
  pick("alc06", "alcohol", 4, 3, [0], "§ 2 Abs. 1 FeV, § 315c StGB"),
  num("alc07", "alcohol", 5, 3.5, "ng/ml", "§ 24a Abs. 1a, Abs. 2a, § 24c StVG"),
  pick("alc08", "alcohol", 4, 3, [0], "§ 2a Abs. 1, Abs. 2a StVG"),
  num("alc09", "alcohol", 4, 8, "", "§ 4 Abs. 5 Satz 1 Nr. 3 StVG"),
  pick("alc10", "alcohol", 5, 3, [0, 1, 2], "§ 316 StGB, § 24a StVG"),
  pick("env01", "environment", 3, 2, [0], "§ 30 Abs. 1 StVO"),
  pick("env02", "environment", 2, 3, [0, 1], "§ 30 Abs. 1 StVO"),
  pick("env03", "environment", 2, 3, [0, 1], "§ 30 Abs. 1 StVO"),
  pick("env04", "environment", 3, 2, [0], "§ 30 Abs. 1 Satz 3 StVO"),
  pick("env05", "environment", 2, 2, [0], "§ 30 Abs. 1 StVO"),
  pick("env06", "environment", 3, 2, [0], "Anlage 2 StVO, Zeichen 270.1", { sign: "270.1" }),
  pick("env07", "environment", 2, 2, [0], "§ 8 AltölV"),
  pick("env08", "environment", 2, 2, [0], "§ 30 Abs. 1 StVO"),
  pick("env09", "environment", 2, 2, [0], "§ 30 Abs. 1 StVO"),
  pick("env10", "environment", 3, 2, [0], "§ 30 Abs. 1 StVO"),
  num("tec01", "technique", 3, 1.6, "mm", "§ 36 Abs. 3 StVZO"),
  pick("tec02", "technique", 3, 2, [0], "§ 2 Abs. 3a StVO, § 36 Abs. 4 StVZO"),
  pick("tec03", "technique", 3, 2, [0], "§ 41b StVZO"),
  pick("tec04", "technique", 3, 3, [0, 1, 2], "§ 53a Abs. 2, § 35h StVZO"),
  pick("tec05", "technique", 3, 2, [0], "§ 23 Abs. 2 StVO"),
  pick("tec06", "technique", 2, 2, [0], "§ 36 StVZO"),
  pick("tec07", "technique", 3, 2, [0], "§ 29 StVZO, Anlage VIII"),
  pick("tec08", "technique", 3, 2, [0], "§ 3 Abs. 1 StVO"),
  pick("tec09", "technique", 2, 2, [0], "§ 41 StVZO"),
  pick("tec10", "technique", 3, 2, [0, 1], "§ 21a Abs. 1 StVO"),
  pick("tec11", "technique", 2, 2, [0], "§ 23 Abs. 1 StVO"),
  pick("tec12", "technique", 3, 2, [0], "§ 3 Abs. 1 StVO"),
  num("clb01", "classB", 4, 3500, "kg", "§ 6 Abs. 1 FeV"),
  pick("clb02", "classB", 4, 3, [0, 1], "§ 6 Abs. 1 FeV (Klasse B)"),
  pick("clb03", "classB", 3, 3, [0], "§ 6 Abs. 1 FeV"),
  pick("clb04", "classB", 4, 3, [0, 1], "§ 22 Abs. 4, Abs. 5 StVO"),
  pick("clb05", "classB", 5, 2, [0], "§ 22 Abs. 1 StVO"),
  pick("clb06", "classB", 4, 3, [0, 1, 2], "§ 15a Abs. 1, Abs. 3 StVO, § 43 Abs. 3 StVZO"),
  pick("clb07", "classB", 4, 3, [0, 1], "§ 3 Abs. 1 StVO"),
  num("clb08", "classB", 3, 17, "", "§ 48a FeV"),
  pick("clb09", "classB", 3, 3, [0, 1], "§ 6 Abs. 3 FeV"),
  pick("clb10", "classB", 4, 3, [0, 1], "§ 22 Abs. 1, § 23 Abs. 1 StVO"),
  pick("clb11", "classB", 5, 3, [0], "§ 23 Abs. 1 StVO"),
  num("clb12", "classB", 4, 4, "m", "§ 22 Abs. 2 StVO, § 32 Abs. 2 StVZO"),
];
