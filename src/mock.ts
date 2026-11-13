/**
 * MOCK=1 mode: canned, persona-flavoured content so the UI and the stick
 * mechanics can be developed and demoed without an API key or spend.
 */
import type { Ballot, Dossier, MKProfile, Speech, Stance, Tone } from "./types.js";
import type { SpeakContext } from "./agent.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const delay = () => sleep(Number(process.env.MOCK_DELAY ?? 700) * (0.5 + Math.random()));

const OPENERS: Record<string, string[]> = {
  netanyahu: ["אני רוצה להגיד לכם משהו.", "תקשיבו טוב.", "Bottom line, חברים:"],
  eisenkot: ["שלוש נקודות.", "אני אגיד את זה בצורה עניינית.", "בארבעים שנות שירות למדתי דבר אחד:"],
  bennett: ["תקשיבו, חבר'ה,", "אני אגיד לכם בכנות:", "יש פה שלוש בעיות ושלושה פתרונות."],
  jabareen: ["אדוני היושב ראש,", "מבחינה משפטית, הדבר ברור:", "אלחק ואצ'ח, האמת ברורה:"],
  golan: ["אני אומר את זה בפה מלא:", "קוראים לדבר בשמו.", "אני לא אתנצל על זה:"],
  abbas: ["בשם אללה הרחמן והרחום, חבריי,", "אחי, בואו נדבר בשקט.", "השולחן פתוח, ואני אומר לכם:"],
  lieberman: ["אני אומר בצורה הכי ברורה:", "תעשו לי טובה.", "בלי שום קשר למה שנאמר כאן,"],
  asher: ["בעזרת השם,", "כמו שאומרים אצלנו,", "רבותיי, הציבור שלנו מבין דבר אחד:"],
  bengvir: ["תגידו לי,", "עם ישראל חי! ועכשיו לעניין:", "הגיע הזמן להגיד את האמת:"],
  deri: ["חביבי, בואו נדבר כמו אנשים.", "אחי היקר,", "אמא שלי, עליה השלום, הייתה אומרת:"],
  smotrich: ["בואו נדבר אמת.", "זה עניין של עקרון.", "אני לא מתנצל על הציונות שלי."],
};

const BODIES = [
  "הנושא של {topic} הוא לא עוד סעיף בסדר היום. הוא מבחן לאחריות של כל מי שיושב באולם הזה.",
  "שמעתי את {target}, ואני חייב להגיד שזה בדיוק הבלבול שהביא אותנו למצב הזה.",
  "מי שמדבר היום על {topic} בלי לדבר על המחיר האמיתי פשוט מוכר לציבור סיסמאות.",
  "{target}, אני מכבד אותך, אבל אתה טועה טעות יסודית. והציבור יודע את זה.",
  "יש לנו הזדמנות לעשות פה משהו אחר, אבל רק אם נפסיק לשחק פוליטיקה על הגב של האזרחים.",
  "אני מוכן לשבת עם כל מי שבאמת רוצה לפתור את {topic}, אבל לא בכל מחיר.",
];

export async function research(mk: MKProfile, topic: string, onProgress: (q: string[]) => void): Promise<Dossier> {
  await delay();
  onProgress([`🔎 ${mk.name} ${topic} 2026`, `🔎 site:knesset.gov.il ${mk.name.split(" ").pop()} ${topic}`]);
  await delay();
  return {
    mkId: mk.id,
    notes: `## המצב שלי עכשיו\n(מצב דמו) ${mk.party}: ${mk.seats} מנדטים, בעיצומו של משא ומתן קואליציוני.\n## העמדה שלי בנושא\nעמדה מוסקת מהאידיאולוגיה (מוסק, לא מאומת).\n## האסטרטגיה שלי\nלבלוט, לעקוץ את היריבים ולשמור על הבייס.`,
    sources: [{ title: `ויקיפדיה: ${mk.name}`, url: `https://he.wikipedia.org/wiki/${encodeURIComponent(mk.name)}` }],
    fromCache: false,
  };
}

export async function speak(mk: MKProfile, ctx: SpeakContext) {
  await delay();
  const prev = ctx.previousSpeeches.at(-1);
  const others = [...new Set(ctx.previousSpeeches.map((s) => s.mkId))].filter((id) => id !== mk.id);
  const targetId = prev && prev.mkId !== mk.id ? prev.mkId : others.length ? pick(others) : "";
  const targetName = targetId ? ctx.names[targetId] ?? "חברי" : "חברי הכנסת";
  const body = [pick(BODIES), pick(BODIES)]
    .join(" ")
    .replaceAll("{topic}", ctx.topic)
    .replaceAll("{target}", targetName);
  const tone = pick<Tone>(["calm", "passionate", "angry", "sarcastic", "conciliatory", "humorous"]);
  const stance = pick<Stance>(["for", "against", "mixed"]);
  const n = ctx.previousSpeeches.length;
  return {
    mkId: mk.id,
    text: `${pick(OPENERS[mk.id] ?? ["חברי הכנסת,"])} ${body}`,
    addressedTo: targetId ? [targetId] : [],
    tone,
    stance,
    innerThought: pick([
      "צריך לגנוב את הכותרת של מחר.",
      "אם אני משחק את זה נכון, אני נכנס לקואליציה עם תיק בכיר.",
      "הוא עוד יתחרט על מה שאמר עליי.",
      "הבייס שלי צריך לשמוע אותי חזק פה.",
    ]),
    readyToVote: n > 8 && Math.random() < 0.6,
    docContribution: ctx.task && Math.random() < 0.6 ? pick([
      `סעיף שדורש מ${mk.party}: תקציב ייעודי ולוח זמנים של 12 חודשים.`,
      `הסתייגות של ${mk.party}: בלי פגיעה בציבור שלנו.`,
      `צעד מעשי: צוות בין-משרדי שמדווח לכנסת כל רבעון.`,
    ]) : "",
    proposedResolution: Math.random() < 0.25 ? `הכנסת מחליטה להקים צוות מיוחד שיגיש תוך 60 יום תוכנית בנושא ${ctx.topic}.` : "",
    sources: [],
    queries: Math.random() < 0.3 ? [`🔎 ${ctx.topic} נתונים 2026`] : [],
  };
}

export async function react(mk: MKProfile, speaker: MKProfile, speech: Speech) {
  await sleep(150 + Math.random() * 600);
  const attacked = speech.addressedTo.includes(mk.id);
  const urgency = attacked ? 7 + Math.floor(Math.random() * 4) : Math.floor(Math.random() * 7);
  return {
    thought: attacked ? `${speaker.name} תוקף אותי? הוא יקבל תשובה.` : pick(["מעניין לאן זה הולך.", "שוב אותו נאום.", "זה יכול לשרת אותי.", "לא מסכים במילה."]),
    emoji: attacked ? pick(["😤", "🤨", "😡"]) : pick(["🙄", "👏", "🤔", "😏", "😴", "👍"]),
    wants_floor: urgency >= 6,
    urgency,
    heckle: urgency >= 8 ? pick(["שקר!", "תתבייש!", "מה אתה מדבר?!", "בושה!", "חוצפה!"]) : "",
  };
}

export async function vote(mk: MKProfile, _resolution: string): Promise<Ballot> {
  await delay();
  const lean: Record<string, number> = { right: 0.3, haredi: 0.35, "center-right": 0.5, center: 0.6, left: 0.7, arab: 0.55 };
  const r = Math.random();
  const p = lean[mk.bloc] ?? 0.5;
  const v = r < p ? "for" : r < p + 0.12 ? "abstain" : "against";
  return { mkId: mk.id, vote: v, explanation: `(דמו) ${mk.name}: ${v === "for" ? "אני תומך כי זה טוב לאזרחים." : v === "against" ? "זו הצעה חלולה ואני מתנגד." : "אני נמנע, כי ההצעה לא בשלה."}` };
}

export async function resolution(topic: string, proposals: string[]): Promise<string> {
  await delay();
  return proposals.at(-1) ?? `הכנסת מחליטה להטיל על הממשלה לגבש תוך 90 יום תוכנית לאומית בנושא "${topic}" ולהציגה למליאה.`;
}

export async function summary(): Promise<{ summary: string; highlights: { between: string[]; event: string }[] }> {
  await delay();
  return {
    summary: "(דמו) הדיון היה סוער, עם הרבה קריאות ביניים ועקיצות. בסוף הוחלט להצביע, והתוצאה משקפת את הגושים הקיימים.",
    highlights: [],
  };
}

export async function document(topic: string, task: string, contributions: string): Promise<{ title: string; markdown: string }> {
  await delay();
  return {
    title: `(דמו) מענה למטלה: ${task.slice(0, 50)}`,
    markdown: `## רקע\nבמליאה התקיים דיון סוער בנושא "${topic}".\n\n## ההמלצות\n1. להקים צוות בין-משרדי.\n2. להקצות תקציב ייעודי.\n3. לדווח לכנסת כל רבעון.\n\n## הצעות שעלו בדיון\n${contributions || "(אין)"}\n\n## מחלוקות והסתייגויות\n- (דמו) חלק מהסיעות מתנגדות ללוח הזמנים.`,
  };
}
