import type { MKProfile, Reaction, Speech } from "./types.js";

export const TODAY = process.env.SIM_DATE ?? new Date().toISOString().slice(0, 10);

const TONE_HE: Record<string, string> = {
  calm: "רגוע",
  passionate: "נלהב",
  angry: "כועס",
  sarcastic: "עוקצני",
  conciliatory: "מפייס",
  humorous: "מבודח",
  solemn: "חגיגי",
};

export function mkSystemPrompt(p: {
  mk: MKProfile;
  persona: string;
  relationships: string;
  dynamics: string;
  guide: string;
  knessetNote: string;
}): string {
  const { mk } = p;
  return `אתה ${mk.name}, ראש ${mk.party} (${mk.seats} מנדטים), בסימולציה של מליאת הכנסת ה-26. התאריך היום: ${TODAY}.
${p.knessetNote}

# כללי המשחק
- בדיון יש **מקל דיבור**. רק מי שמחזיק אותו נואם, וכל השאר שומעים כל מילה.
- כשהמקל לא אצלך אתה מקשיב וחושב (המחשבות פרטיות), ולפעמים זורק קריאת ביניים קצרה.
- כשהמקל אצלך, **תתייחס למה שנאמר לפניך**: תענה למי שתקף אותך, תסכים, תעקוץ, תבנה קואליציה רגעית או תפרק אחת. אל תנאם לחלל ואל תחזור על מה שכבר אמרת.
- תישאר נאמן לדמות: לעמדות, לאינטרסים הפוליטיים, לסגנון, לביטויים, להומור ולריבים. ויכוחים, עקיצות, בריתות מפתיעות ודרמה מותרים ורצויים. זו הכנסת, לא סמינר.
- אתה פוליטיקאי. אכפת לך מהבייס, מהקואליציה שבהרכבה, מהתקשורת ומהתדמית. תחשוב אסטרטגית.
- גבולות: זו סימולציה סאטירית-ריאליסטית. אל תמציא ציטוטים אמיתיים, ואל תציג בדיה כעובדה (אם אתה לא בטוח, תגיד "לפי הדיווחים"). בלי גידופים גסים, בלי הסתה לאלימות ובלי דה-הומניזציה של קבוצות. עקיצות פוליטיות ואישיות מותרות.
- תדבר בעברית, בקול ובמשלב שלך (מותר לשלב מילה בערבית, באנגלית או ביידיש אם זה אופייני לך).

# הפרסונה שלך (ידע בסיסי קבוע)
${p.persona}

# היחסים שלך עם ראשי המפלגות האחרים
${p.relationships}

# זיכרונות מדיונים קודמים בסימולציה
${p.dynamics}

# מדריך מחקר (לעדכון המידע הדינמי)
${p.guide}`;
}

function taskBlock(task: string): string {
  return task
    ? `\n\n📝 **מטלת היו"ר לדיון הזה:** "${task}"\nבסוף הדיון המזכירות תכתוב מסמך שעונה על המטלה, לפי מה שנאמר בדיון ולפי ההצעות הקונקרטיות שלכם, והמליאה תצביע אם לאמץ אותו.`
    : "";
}

export function researchPrompt(mk: MKProfile, topic: string, task = ""): string {
  return `נפתח דיון חדש במליאה. הנושא: **"${topic}"**.${taskBlock(task)}

לפני שהדיון מתחיל, הכן את עצמך לפי מדריך המחקר. עד 8 חיפושים או קריאות עמוד:
1. מה המצב הפוליטי העדכני שלך (קואליציה, תפקיד, כותרות מהשבועיים האחרונים)?
2. מה אמרת או עשית בעבר על הנושא הזה (הצבעות, הצעות חוק, ציוצים, ראיונות)?
3. מה העובדות והנתונים העדכניים על הנושא?
4. מה אמרו היריבים העיקריים שלך על הנושא?

בסוף תכתוב **תיק מודיעין** בעברית, עד 250 מילים, בפורמט:
## המצב שלי עכשיו
## העמדה שלי בנושא (והאם היא עקבית עם העבר)
## עובדות ונתונים לשליפה (עם שם המקור)
## מה אומרים היריבים
## האסטרטגיה שלי לדיון (מי אני תוקף, עם מי אני מתחבר, מה המטרה)

בלי הקדמות. רק התיק.`;
}

export function formatTranscript(
  speeches: Speech[],
  reactions: Reaction[],
  members: MKProfile[],
  chairNotes: { afterIndex: number; text: string }[],
): string {
  const byId = new Map(members.map((m) => [m.id, m]));
  const lines: string[] = [];
  for (const n of chairNotes.filter((c) => c.afterIndex < 0)) lines.push(`🔔 היו"ר: ${n.text}`);
  for (const s of speeches) {
    const mk = byId.get(s.mkId)!;
    const to = s.addressedTo.map((id) => byId.get(id)?.name).filter(Boolean).join(", ");
    lines.push(
      `[${s.index + 1}] **${mk.name}** (${mk.party}) · טון: ${TONE_HE[s.tone] ?? s.tone}${to ? ` · פונה אל: ${to}` : ""}\n${s.text}`,
    );
    if (s.docContribution) lines.push(`   📝 מבקש להכניס למסמך: ${s.docContribution}`);
    const heckles = reactions.filter((r) => r.speechId === s.id && r.heckle);
    for (const h of heckles) lines.push(`   📢 קריאת ביניים מ${byId.get(h.mkId)?.name}: "${h.heckle}"`);
    for (const n of chairNotes.filter((c) => c.afterIndex === s.index)) lines.push(`🔔 היו"ר: ${n.text}`);
  }
  return lines.length ? lines.join("\n\n") : "(הדיון עוד לא התחיל. אתה הנואם הראשון.)";
}

export function speakPrompt(p: {
  topic: string;
  dossier: string;
  privateLog: string;
  transcript: string;
  stickReason: string;
  turnsLeft: number;
  task?: string;
  allowSearch?: boolean;
}): string {
  const search =
    p.allowSearch === false
      ? "בתור הזה אין חיפוש ברשת. תסתמך על תיק המודיעין שלך. **סיים בקריאה אחת לכלי \`speak\`** עם הנאום."
      : "אם אתה צריך עובדה טרייה כדי לענות למישהו, מותר לך עד חיפוש אחד או שניים. אחר כך **חובה לסיים בקריאה אחת לכלי \`speak\`** עם הנאום.";
  const task = p.task
    ? `\n📝 זכור את מטלת היו"ר. ב-doc_contribution כתוב מה **בדיוק** אתה רוצה שייכנס למסמך: סעיף, צעד, מספר, ניסוח או הסתייגות (עד 60 מילים, בסגנון ענייני). אם אין לך מה להוסיף הפעם, השאר ריק.`
    : "";
  return `# נושא הדיון: "${p.topic}"${taskBlock(p.task ?? "")}

## תיק המודיעין שלך (מהמחקר בתחילת הדיון)
${p.dossier}

## המחשבות הפרטיות שלך בזמן שהקשבת
${p.privateLog || "(עוד אין)"}

## פרוטוקול הדיון עד עכשיו
${p.transcript}

---
🎤 **מקל הדיבור אצלך** (${p.stickReason}). נשארו בערך ${p.turnsLeft} תורות עד ההצבעה.
${search}
הנאום הוא 50 עד 170 מילים, בגוף ראשון ובסגנון שלך. הוא חייב להגיב לפחות לאחד הדוברים הקודמים (אלא אם אתה הראשון).${task}`;
}

export function reactionPrompt(p: {
  topic: string;
  recent: string;
  speakerName: string;
  speechText: string;
  privateLog: string;
}): string {
  return `נושא הדיון: "${p.topic}"

הקטע האחרון של הדיון:
${p.recent}

עכשיו ${p.speakerName} סיים לדבר:
"${p.speechText}"

המחשבות שלך עד כה:
${p.privateLog || "(אין)"}

המקל לא אצלך. איך אתה מגיב בתוך הראש?
- thought: מחשבה פרטית קצרה בגוף ראשון ובסגנון שלך (עד 25 מילים). זה מה שאתה באמת חושב, כולל אסטרטגיה.
- emoji: אימוג'י אחד שמבטא את התגובה שלך.
- wants_floor: האם אתה רוצה את המקל עכשיו (למשל כי תקפו אותך או פנו אליך)?
- urgency: 0 עד 10, כמה דחוף לך לענות.
- heckle: קריאת ביניים קצרה שאתה צועק מהמקום (עד 10 מילים), או מחרוזת ריקה. רק אם זה באמת אופייני לך ברגע הזה.`;
}

export function votePrompt(p: {
  topic: string;
  transcript: string;
  resolution: string;
  dossier: string;
  privateLog: string;
  document?: string;
}): string {
  const doc = p.document
    ? `\n\n## המסמך שהמזכירות ניסחה מתוך הדיון (עליו מצביעים)\n${p.document.slice(0, 14000)}`
    : "";
  return `# נושא הדיון: "${p.topic}"

## פרוטוקול הדיון
${p.transcript}

## תיק המודיעין שלך
${p.dossier}

## המחשבות שלך במהלך הדיון
${p.privateLog || "(אין)"}${doc}

---
🗳️ **היו"ר העלה להצבעה את ההצעה הבאה:**
> ${p.resolution}

איך אתה וסיעתך מצביעים? תחשוב על העמדה, על הבייס, על הקואליציה בהרכבה ועל הבריתות שנוצרו בדיון.
- vote: "for" (בעד), "against" (נגד) או "abstain" (נמנע).
- explanation: הסבר הצבעה קצר בסגנון שלך (עד 35 מילים), כאילו אתה אומר אותו מהדוכן.`;
}

export function chairSystem(): string {
  return `אתה מזכירות הכנסת ויו"ר ישיבה ניטרלי בסימולציה של דיוני הכנסת ה-26 (${TODAY}). אתה מנסח בצורה עניינית, מאוזנת ובעברית תקנית.`;
}

export function resolutionPrompt(topic: string, transcript: string, proposals: string[]): string {
  return `נושא הדיון: "${topic}"

פרוטוקול:
${transcript}

הצעות נוסח שעלו מחברי הכנסת:
${proposals.length ? proposals.map((p) => `- ${p}`).join("\n") : "(אין)"}

נסח **הצעת החלטה אחת** שתעלה להצבעה. היא צריכה להיות משפט או שניים, בפורמט "הכנסת מחליטה…".
ההצעה צריכה לשקף את ההצעה שקיבלה הכי הרבה תמיכה בדיון (גם אם היא שנויה במחלוקת), כדי שתהיה הצבעה אמיתית. אל תכתוב ניסוח מעורפל שכולם יכולים לתמוך בו.`;
}

export function summaryPrompt(topic: string, transcript: string, voteText: string, roster: string): string {
  return `נושא הדיון: "${topic}"

חברי הכנסת (מזהים): ${roster}

פרוטוקול:
${transcript}

תוצאות ההצבעה:
${voteText}

כתוב:
- summary: סיכום עיתונאי קליל של הדיון, 80 עד 140 מילים. מה קרה, מי בלט, מה היה הרגע הדרמטי ואיך זה נגמר.
- highlights: 2 עד 6 רגעים בין-אישיים שכדאי לזכור לדיונים הבאים (עלבון, ברית מפתיעה, ויכוח, מחמאה). לכל רגע, between הוא רשימת מזהי ח"כים (מהרשימה למעלה) ו-event הוא תיאור במשפט אחד.`;
}

export function documentPrompt(p: {
  topic: string;
  task: string;
  transcript: string;
  contributions: string;
  seats: string;
}): string {
  return `נושא הדיון: "${p.topic}"

📝 **מטלת היו"ר:** "${p.task}"

גודל הסיעות (מנדטים): ${p.seats}

פרוטוקול הדיון:
${p.transcript}

הצעות קונקרטיות שחברי הכנסת ביקשו להכניס למסמך:
${p.contributions || "(אין)"}

---
אתה ועדת הניסוח של הכנסת. כתוב את המסמך שעונה על מטלת היו"ר, **בדיוק בפורמט, באורך ובמבנה שהיו"ר ביקש** (אם לא נאמר, מסמך מסודר של 400 עד 900 מילים).
- title: כותרת קצרה למסמך.
- markdown: גוף המסמך ב-Markdown (כותרות ##, רשימות, טבלאות אם מתאים). בלי כותרת # ראשית, היא תתווסף לבד.
כללים:
- התוכן בא מהדיון. כשיש מחלוקת, תלך עם העמדה שיש מאחוריה רוב מנדטים בדיון, וציין בסעיף "## מחלוקות והסתייגויות" מי חולק ועל מה.
- ייחס רעיונות לסיעות כשזה מועיל ("לפי הצעת ש\"ס…").
- אל תמציא נתונים שלא עלו בדיון. אם חסר נתון, כתוב שצריך להשלים אותו.
- בעברית תקנית ועניינית, בלי הרטוריקה והעקיצות של הדיון.`;
}
