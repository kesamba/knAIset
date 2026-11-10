/* כנסת AI: client. Every UI change is driven by game events, so live view and replay share one code path. */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const words = (t) => (t || "").trim().split(/\s+/).filter(Boolean).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TONE = { calm: "רגוע", passionate: "נלהב", angry: "כועס 😠", sarcastic: "עוקצני 😏", conciliatory: "מפייס 🤝", humorous: "מבודח 😄", solemn: "חגיגי" };
const TONE_COLOR = { calm: "#8aa0c8", passionate: "#f08c2e", angry: "#d64545", sarcastic: "#9b59d0", conciliatory: "#2f9e5b", humorous: "#e3b22b", solemn: "#3a5bb8" };
const STANCE = { for: "בעד", against: "נגד", mixed: "מעורב", undecided: "מתלבט" };
const VOTE = { for: "בעד ✅", against: "נגד ❌", abstain: "נמנע ⚪" };
const PHASE = { research: "🔎 מחקר מקדים: הח״כים מתכוננים", debate: "🎤 דיון במליאה", voting: "🗳️ הצבעה", done: "✅ הישיבה ננעלה", error: "⚠️ תקלה" };
const BLOC_ORDER = ["arab", "left", "center", "center-right", "haredi", "right"];
const SUGGESTIONS = [
  "חוק גיוס לבני ישיבות",
  "הקמת ועדת חקירה ממלכתית לאירועי 7 באוקטובר",
  "תחבורה ציבורית בשבת",
  "מאבק בפשיעה בחברה הערבית",
  "הורדת מחירי הדיור",
  "עונש מוות למחבלים",
  "נישואין אזרחיים",
  "הרכבת ממשלת אחדות",
];

let roster = null;
let cfg = {};
let S = null; // current session view-state
let es = null;
let replaying = false;

// ---------------- boot ----------------
(async function boot() {
  [roster, cfg] = await Promise.all([fetch("/api/roster").then((r) => r.json()), fetch("/api/config").then((r) => r.json())]);
  $("#modeBadge").hidden = !cfg.mock;
  const chips = $("#topicChips");
  for (const s of SUGGESTIONS) {
    const b = el("button", "chip", esc(s));
    b.type = "button";
    b.onclick = () => ($("#topicInput").value = s);
    chips.append(b);
  }
  const pick = $("#memberPick");
  for (const m of roster.members) {
    const p = el("button", "pill", `${m.emoji} ${esc(m.name)} <span class="muted">${m.seats}</span>`);
    p.type = "button";
    p.style.setProperty("--c", m.color);
    p.dataset.id = m.id;
    p.onclick = () => p.classList.toggle("off");
    pick.append(p);
  }
  $("#startForm").onsubmit = startSession;
  $("#homeLink").onclick = (e) => { e.preventDefault(); goHome(); };
  $("#historyBtn").onclick = openHistory;
  $("#pauseBtn").onclick = togglePause;
  $("#voteBtn").onclick = () => { $("#customResolution").value = ""; $("#voteDialog").showModal(); };
  $("#voteDialog").onclose = () => { if ($("#voteDialog").returnValue === "go") control({ action: "vote", resolution: $("#customResolution").value }); };
  $("#chairSend").onclick = sendChair;
  $("#chairInput").onkeydown = (e) => { if (e.key === "Enter") sendChair(); };
  $("#thoughtsToggle").onchange = (e) => $("#feed").classList.toggle("hide-thoughts", !e.target.checked);
  $("#mkDialog").onclose = () => { if ($("#mkDialog").returnValue === "stick" && S?.openMk) control({ action: "stick", mkId: S.openMk }); };
  $("#analysisBtn").onclick = showAnalysis;
  $("#backToLive").onclick = () => show("live");
  $("#replayBtn").onclick = replay;
  window.addEventListener("resize", () => S && drawLiveLinks());
  route();
})();

function route() {
  const m = location.hash.match(/^#\/s\/(.+)$/);
  if (m) openSession(m[1]);
  else show("start");
}

function show(view) {
  for (const v of ["start", "live", "analysis"]) $(`#${v}View`).hidden = v !== view;
  window.scrollTo({ top: 0 });
}

function goHome() {
  es?.close();
  replaying = false;
  location.hash = "";
  show("start");
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------- session lifecycle ----------------
async function startSession(e) {
  e.preventDefault();
  const topic = $("#topicInput").value.trim();
  if (!topic) return;
  const memberIds = [...document.querySelectorAll("#memberPick .pill:not(.off)")].map((p) => p.dataset.id);
  if (memberIds.length < 2) return toast("צריך לפחות שני ח״כים לדיון");
  const r = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, maxTurns: Number($("#maxTurns").value), memberIds }),
  }).then((r) => r.json());
  if (r.error) return toast(r.error);
  location.hash = `#/s/${r.id}`;
  openSession(r.id);
}

function openSession(id) {
  es?.close();
  replaying = false;
  show("live");
  es = new EventSource(`/api/sessions/${id}/stream`);
  es.addEventListener("snapshot", (m) => {
    const snap = JSON.parse(m.data);
    resetView(snap);
    for (const ev of snap.events) apply(ev, false);
    S.live = !["done", "error"].includes(snap.phase);
    syncControls();
  });
  es.addEventListener("game", (m) => apply(JSON.parse(m.data), true));
  es.addEventListener("fatal", (m) => toast(JSON.parse(m.data).message));
  es.onerror = () => { if (S && !S.live) es.close(); };
}

async function control(body) {
  if (!S) return;
  const r = await fetch(`/api/sessions/${S.id}/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  if (r.error) toast(r.error);
}

function togglePause() {
  control({ action: S.paused ? "resume" : "pause" });
}

function sendChair() {
  const v = $("#chairInput").value.trim();
  if (!v) return;
  control({ action: "chair", text: v });
  $("#chairInput").value = "";
}

function syncControls() {
  const live = S.live && !replaying && ["research", "debate"].includes(S.phase);
  $("#liveControls").hidden = !live;
  $("#chairBar").hidden = !live;
  $("#pauseBtn").textContent = S.paused ? "▶️ המשך" : "⏸️ השהיה";
}

// ---------------- view state ----------------
function resetView(snap) {
  const members = [...snap.members].sort((a, b) => BLOC_ORDER.indexOf(a.bloc) - BLOC_ORDER.indexOf(b.bloc) || a.seats - b.seats);
  S = {
    id: snap.id,
    topic: snap.topic,
    createdAt: snap.createdAt,
    phase: "research",
    members,
    byId: Object.fromEntries(members.map((m) => [m.id, m])),
    dossiers: {},
    queries: {},
    speeches: [],
    reactions: [],
    events: [],
    stick: null,
    paused: false,
    live: true,
    vote: null,
    ballots: [],
    summary: "",
    openMk: null,
  };
  $("#topicTitle").textContent = snap.topic;
  $("#feed").innerHTML = "";
  $("#voteSection").hidden = true;
  $("#voteGrid").innerHTML = "";
  $("#seatBar").innerHTML = "";
  $("#stamp").hidden = true;
  $("#summaryText").textContent = "";
  $("#analysisBtn").hidden = true;
  $("#podiumName").textContent = "הישיבה נפתחת…";
  $("#podiumText").textContent = "";
  buildSeats($("#plenum"), S.members, true);
  moveStick(null);
  setPhase("research");
}

function seatPos(i, n) {
  const t = n === 1 ? 0.5 : i / (n - 1);
  const a = Math.PI * (1 - t);
  return { x: 50 + 42 * Math.cos(a), y: 80 - 66 * Math.sin(a) };
}

function buildSeats(container, members, clickable) {
  container.querySelectorAll(".seat").forEach((s) => s.remove());
  members.forEach((m, i) => {
    const p = seatPos(i, members.length);
    const s = el("div", "seat", `<div class="avatar">${m.emoji}<span class="seats-n">${m.seats}</span></div><div class="nm">${esc(m.name)}</div><div class="pt">${esc(m.party)}</div>`);
    s.style.left = `${p.x}%`;
    s.style.top = `${p.y}%`;
    s.style.setProperty("--c", m.color);
    s.dataset.id = m.id;
    if (clickable) s.onclick = () => openMk(m.id);
    container.append(s);
  });
}

const seatEl = (id) => document.querySelector(`#plenum .seat[data-id="${id}"]`);

function setPhase(p) {
  S.phase = p;
  $("#phaseLabel").textContent = PHASE[p] ?? p;
  syncControls();
}

function moveStick(id) {
  const stick = $("#stick");
  if (!id) {
    stick.style.left = "50%";
    stick.style.top = "42%";
    return;
  }
  const s = seatEl(id);
  if (!s) return;
  stick.style.left = `calc(${s.style.left} + 30px)`;
  stick.style.top = `calc(${s.style.top} - 30px)`;
}

// ---------------- feed ----------------
function feedAdd(node) {
  const f = $("#feed");
  const nearBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 120;
  f.append(node);
  if (nearBottom || replaying) f.scrollTop = f.scrollHeight;
}

function systemEntry(html) {
  feedAdd(el("div", "entry system", html));
}

function speechEntry(sp) {
  const m = S.byId[sp.mkId];
  const to = sp.addressedTo.map((id) => S.byId[id]?.name).filter(Boolean);
  const e = el("div", "entry");
  e.id = `entry-${sp.id}`;
  e.style.setProperty("--c", m.color);
  e.innerHTML = `
    <div class="who"><span class="dot">${m.emoji}</span>${esc(m.name)} <span class="muted small">(${esc(m.party)})</span>
      <span class="meta"><span class="tag tone-${sp.tone}">${TONE[sp.tone] ?? sp.tone}</span><span class="tag">${STANCE[sp.stance] ?? ""}</span>${sp.readyToVote ? '<span class="tag">🗳️ מוכן להצביע</span>' : ""}</span></div>
    ${to.length ? `<div class="to">↩︎ פונה אל: ${to.map(esc).join(", ")}</div>` : ""}
    <div class="text">${esc(sp.text)}</div>
    ${sp.innerThought ? `<div class="inner">🧠 ${esc(sp.innerThought)}</div>` : ""}
    ${sp.proposedResolution ? `<div class="to">📝 מציע: ${esc(sp.proposedResolution)}</div>` : ""}
    <div class="heckles"></div>
    <div class="reacts thoughts-only"></div>
    ${sp.sources?.length ? `<div class="srcs">📎 ${sp.sources.slice(0, 4).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.slice(0, 40))}</a>`).join("")}</div>` : ""}`;
  feedAdd(e);
}

// ---------------- event reducer ----------------
function apply(ev, animate) {
  S.events.push(ev);
  const name = (id) => S.byId[id]?.name ?? id;
  switch (ev.type) {
    case "phase":
      setPhase(ev.phase);
      if (ev.phase === "debate") systemEntry("🔔 <b>היו״ר:</b> הישיבה נפתחת. מקל הדיבור מוכן.");
      if (ev.phase === "done" || ev.phase === "error") {
        S.live = false;
        moveStick(null);
        document.querySelectorAll("#plenum .seat").forEach((s) => s.classList.remove("speaking", "hand", "researching"));
        syncControls();
      }
      break;
    case "research_started":
      seatEl(ev.mkId)?.classList.add("researching");
      break;
    case "research_progress":
      S.queries[ev.mkId] = [...(S.queries[ev.mkId] ?? []), ...ev.queries];
      if (ev.queries.length)
        systemEntry(`🔎 <b>${esc(name(ev.mkId))}</b> חוקר:<br>${ev.queries.slice(0, 8).map(esc).join("<br>")}`);
      break;
    case "research_done": {
      S.dossiers[ev.mkId] = ev.dossier;
      const s = seatEl(ev.mkId);
      s?.classList.remove("researching");
      s?.classList.add("ready");
      systemEntry(`📁 <b>${esc(name(ev.mkId))}</b> סיים להכין תיק מודיעין${ev.dossier.fromCache ? " (מהמטמון)" : ""}${ev.dossier.sources?.length ? ` · ${ev.dossier.sources.length} מקורות` : ""}`);
      break;
    }
    case "agent_error":
      systemEntry(`⚠️ תקלה אצל ${esc(name(ev.mkId))} (${esc(ev.stage)}): ${esc(ev.message).slice(0, 160)}`);
      break;
    case "stick_passed":
      document.querySelectorAll("#plenum .seat").forEach((s) => s.classList.remove("speaking", "hand", "ready"));
      seatEl(ev.mkId)?.classList.add("speaking");
      S.stick = ev.mkId;
      moveStick(ev.mkId);
      $("#podiumName").textContent = `🎤 ${name(ev.mkId)}`;
      $("#podiumText").innerHTML = `<span class="muted">💭 חושב… (${esc(ev.reason)})</span>`;
      systemEntry(`🎤 המקל עובר אל <b>${esc(name(ev.mkId))}</b>: ${esc(ev.reason)}`);
      clearLinks();
      break;
    case "speaker_searched":
      $("#podiumText").innerHTML = `<span class="muted">${ev.queries.map(esc).join("<br>")}</span>`;
      systemEntry(`🔎 <b>${esc(name(ev.mkId))}</b> בודק עובדות לפני שהוא עונה: ${ev.queries.map(esc).join(" · ")}`);
      break;
    case "speech":
      S.speeches.push(ev.speech);
      speechEntry(ev.speech);
      typePodium(ev.speech.text, animate);
      drawLiveLinks();
      break;
    case "reaction":
      S.reactions.push(ev.reaction);
      onReaction(ev.reaction, animate);
      break;
    case "chair_note":
      feedAdd(el("div", "entry chair", `🔔 <b>היו״ר:</b> ${esc(ev.text)}`));
      break;
    case "paused":
      S.paused = true;
      syncControls();
      systemEntry("⏸️ הישיבה הושהתה");
      break;
    case "resumed":
      S.paused = false;
      syncControls();
      systemEntry("▶️ הישיבה מתחדשת");
      break;
    case "stick_requested":
      systemEntry(`👉 היו״ר יעביר את המקל ל<b>${esc(name(ev.mkId))}</b> בתור הבא`);
      break;
    case "vote_requested":
      systemEntry(ev.by === "members" ? `🗳️ ${ev.ready} מתוך ${ev.of} הדוברים האחרונים ביקשו לעבור להצבעה` : "🗳️ היו״ר קרא להצבעה");
      break;
    case "vote_called":
      clearLinks();
      moveStick(null);
      document.querySelectorAll("#plenum .seat").forEach((s) => s.classList.remove("speaking", "hand"));
      $("#podiumName").textContent = "🗳️ הצבעה";
      $("#podiumText").textContent = ev.resolution;
      $("#voteSection").hidden = false;
      $("#resolutionText").textContent = ev.resolution;
      systemEntry(`🗳️ <b>עולה להצבעה:</b> ${esc(ev.resolution)}`);
      if (animate) $("#voteSection").scrollIntoView({ behavior: "smooth", block: "start" });
      break;
    case "vote_cast":
      S.ballots.push(ev.ballot);
      addBallot(ev.ballot);
      break;
    case "vote_result":
      S.vote = ev.vote;
      renderSeatBar(ev.vote);
      $("#stamp").hidden = false;
      $("#stamp").className = `stamp ${ev.vote.passed ? "pass" : "fail"}`;
      $("#stamp").textContent = ev.vote.passed ? "ההצעה התקבלה" : "ההצעה נדחתה";
      $("#analysisBtn").hidden = false;
      break;
    case "summary":
      S.summary = ev.summary;
      $("#summaryText").textContent = `📰 ${ev.summary}`;
      break;
    case "fatal":
      systemEntry(`⛔ ${esc(ev.message)}`);
      if (animate) toast(ev.message);
      break;
  }
}

async function typePodium(text, animate) {
  const box = $("#podiumText");
  if (!animate) {
    box.textContent = text;
    return;
  }
  const token = (typePodium._t = (typePodium._t ?? 0) + 1);
  const span = el("span", "typing");
  box.innerHTML = "";
  box.append(span);
  const ws = text.split(/(\s+)/);
  const step = Math.max(12, Math.min(60, 5000 / ws.length));
  for (const w of ws) {
    if (token !== typePodium._t) return;
    span.textContent += w;
    box.scrollTop = box.scrollHeight;
    await sleep(step);
  }
  span.classList.remove("typing");
}

function onReaction(r, animate) {
  const entry = document.querySelector(`#entry-${r.speechId}`);
  if (entry) {
    const em = el("span", null, esc(r.emoji));
    em.title = `${S.byId[r.mkId]?.name}: ${r.thought}`;
    entry.querySelector(".reacts").append(em);
    if (r.heckle) entry.querySelector(".heckles").append(el("div", "heckle", `📢 ${esc(S.byId[r.mkId]?.name)}: "${esc(r.heckle)}"`));
  }
  const seat = seatEl(r.mkId);
  if (!seat) return;
  if (r.wantsFloor && r.urgency >= 6) seat.classList.add("hand");
  if (!animate) return;
  const delay = Math.random() * 1400;
  setTimeout(() => {
    const plenum = $("#plenum");
    const pop = el("div", "reaction-pop", esc(r.emoji));
    pop.style.left = seat.style.left;
    pop.style.top = seat.style.top;
    plenum.append(pop);
    setTimeout(() => pop.remove(), 2500);
    if (r.heckle) {
      const h = el("div", "heckle-pop", `📢 ${esc(r.heckle)}`);
      h.style.left = seat.style.left;
      h.style.top = seat.style.top;
      plenum.append(h);
      setTimeout(() => h.remove(), 3300);
    }
  }, delay);
}

// ---------------- plenum links (who is talking to whom) ----------------
function clearLinks() {
  $("#linksSvg").innerHTML = "";
}

function drawLiveLinks() {
  clearLinks();
  const sp = S.speeches.at(-1);
  if (!sp || S.phase !== "debate") return;
  const lines = sp.addressedTo.map((to) => ({ from: sp.mkId, to, w: 2.5, dashed: false }));
  drawLinks($("#linksSvg"), S.members, lines);
}

function drawLinks(svg, members, lines) {
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.innerHTML = "";
  const idx = Object.fromEntries(members.map((m, i) => [m.id, i]));
  const color = Object.fromEntries(members.map((m) => [m.id, m.color]));
  for (const l of lines) {
    if (!(l.from in idx) || !(l.to in idx)) continue;
    const a = seatPos(idx[l.from], members.length);
    const b = seatPos(idx[l.to], members.length);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    // bow every curve toward the middle of the hall so lines don't hug the seats
    const cx = mx + (50 - mx) * 0.35, cy = my + (70 - my) * 0.35;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", color[l.from]);
    p.setAttribute("stroke-width", l.w);
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("vector-effect", "non-scaling-stroke");
    p.setAttribute("opacity", l.dashed ? 0.55 : 0.8);
    if (l.dashed) p.setAttribute("stroke-dasharray", "4 4");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = l.title ?? "";
    p.append(t);
    svg.append(p);
  }
}

// ---------------- voting ----------------
function addBallot(b) {
  const m = S.byId[b.mkId];
  const c = el("div", `ballot ${b.vote}`, `<div class="who"><b>${m.emoji} ${esc(m.name)}</b> <span class="muted small">${m.seats} מנדטים</span></div><div class="v">${VOTE[b.vote]}</div><div class="ex">${esc(b.explanation)}</div>`);
  $("#voteGrid").append(c);
  const seat = seatEl(b.mkId);
  if (seat) {
    seat.querySelector(".vote-chip")?.remove();
    const chip = el("span", "vote-chip", { for: "בעד", against: "נגד", abstain: "נמנע" }[b.vote]);
    chip.style.background = `var(--${b.vote})`;
    seat.querySelector(".avatar").append(chip);
  }
}

function renderSeatBar(v) {
  const total = Object.values(v.bySeats).reduce((a, b) => a + b, 0) || 1;
  const bar = $("#seatBar");
  bar.innerHTML = "";
  for (const k of ["for", "abstain", "against"]) {
    const d = el("div", null, v.bySeats[k] ? `${{ for: "בעד", against: "נגד", abstain: "נמנעים" }[k]} ${v.bySeats[k]}` : "");
    d.style.width = `${(100 * v.bySeats[k]) / total}%`;
    d.style.background = `var(--${k})`;
    bar.append(d);
  }
  const note = $("#seatBar").nextElementSibling;
  if (!note || !note.classList.contains("seatnote")) {
    $("#seatBar").insertAdjacentHTML("afterend", `<div class="muted small seatnote"></div>`);
  }
  $("#seatBar").nextElementSibling.textContent = `לפי מנדטים: בעד ${v.bySeats.for} · נגד ${v.bySeats.against} · נמנעים ${v.bySeats.abstain}   |   לפי ראשי מפלגות: ${v.byHeads.for}–${v.byHeads.against}–${v.byHeads.abstain}`;
}

// ---------------- MK modal ----------------
function openMk(id) {
  const m = S.byId[id];
  S.openMk = id;
  const d = S.dossiers[id];
  const thoughts = [
    ...S.reactions.filter((r) => r.mkId === id).map((r) => ({ t: r.thought, e: r.emoji, on: S.speeches.find((s) => s.id === r.speechId) })),
  ];
  const mine = S.speeches.filter((s) => s.mkId === id);
  $("#mkDialogBody").innerHTML = `
    <div class="mk-head" style="--c:${m.color}"><div class="avatar">${m.emoji}</div><div><h3 style="margin:0">${esc(m.name)}</h3><div class="muted">${esc(m.party)} · ${m.seats} מנדטים</div></div></div>
    <h4>📁 תיק מודיעין (המחקר שהסוכן עשה בעצמו)</h4>
    <div class="dossier">${d ? esc(d.notes) : '<span class="muted">עדיין חוקר…</span>'}</div>
    ${d?.sources?.length ? `<div class="srcs small">📎 ${d.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title.slice(0, 50))}</a>`).join(" · ")}</div>` : ""}
    ${S.queries[id]?.length ? `<p class="muted small">חיפושים: ${S.queries[id].map(esc).join(" · ")}</p>` : ""}
    <h4>🧠 מחשבות פרטיות</h4>
    <div class="thought-list">${
      [...mine.map((s) => `🎤 (בנאום #${s.index + 1}) ${esc(s.innerThought)}`), ...thoughts.map((x) => `${esc(x.e)} על ${esc(S.byId[x.on?.mkId]?.name ?? "")}: ${esc(x.t)}`)].join("<br>") || '<span class="muted">עוד אין</span>'
    }</div>`;
  $("#giveStickBtn").hidden = !(S.live && S.phase === "debate" && !replaying);
  $("#mkDialog").showModal();
}

// ---------------- history ----------------
async function openHistory() {
  const list = await fetch("/api/sessions").then((r) => r.json());
  const box = $("#historyList");
  box.innerHTML = list.length ? "" : '<p class="muted">עוד אין דיונים שמורים.</p>';
  for (const s of list) {
    const it = el("div", "hist-item", `<span>${esc(s.topic)}</span><span class="muted small">${s.createdAt.slice(0, 16).replace("T", " ")} ${s.passed === true ? "✅" : s.passed === false ? "❌" : "…"}</span>`);
    it.onclick = () => {
      $("#historyDialog").close();
      location.hash = `#/s/${s.id}`;
      openSession(s.id);
    };
    box.append(it);
  }
  $("#historyDialog").showModal();
}

// ---------------- replay ----------------
async function replay() {
  if (!S) return;
  es?.close();
  const events = [...S.events];
  const snap = { id: S.id, topic: S.topic, createdAt: S.createdAt, members: S.members, phase: "research" };
  show("live");
  resetView(snap);
  replaying = true;
  S.live = false;
  syncControls();
  toast("▶️ שידור חוזר");
  for (const ev of events) {
    if (!replaying) return;
    apply(ev, true);
    const d = { stick_passed: 900, speech: Math.min(5200, 25 * words(ev.speech?.text) + 900), reaction: 110, vote_cast: 450, vote_called: 1200, research_done: 120, research_progress: 150, summary: 400 }[ev.type] ?? 60;
    await sleep(d);
  }
  replaying = false;
  syncControls();
}

// ---------------- analysis ----------------
function showAnalysis() {
  show("analysis");
  $("#anTopic").textContent = S.topic;
  const sp = S.speeches;
  const heckles = S.reactions.filter((r) => r.heckle);
  const count = (arr, key) => arr.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
  const top = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
  const outgoing = {};
  const incoming = {};
  for (const s of sp) for (const t of s.addressedTo) {
    outgoing[s.mkId] = (outgoing[s.mkId] ?? 0) + 1;
    incoming[t] = (incoming[t] ?? 0) + 1;
  }
  const heckler = top(count(heckles, (h) => h.mkId));
  const heckledAt = top(count(heckles, (h) => sp.find((s) => s.id === h.speechId)?.mkId));
  const name = (id) => (id ? S.byId[id]?.name : "—");
  const angry = sp.filter((s) => s.tone === "angry").length;
  const stats = [
    [sp.length, "נאומים"],
    [heckles.length, "קריאות ביניים"],
    [sp.reduce((a, s) => a + words(s.text), 0), "מילים נאמרו"],
    [`${Math.round((100 * angry) / (sp.length || 1))}%`, "נאומים בכעס"],
    [name(top(outgoing)?.[0]), "🥊 הכי תוקפני"],
    [name(top(incoming)?.[0]), "🎯 הכי מותקף"],
    [name(heckler?.[0]), "📢 הקריאן הראשי"],
    [name(heckledAt?.[0]), "🙉 ספג הכי הרבה קריאות"],
  ];
  $("#statCards").innerHTML = stats.map(([n, l]) => `<div class="card stat"><div class="n${typeof n === "string" && n.length > 6 ? " txt" : ""}">${esc(n ?? "—")}</div><div class="l">${l}</div></div>`).join("");

  // interaction map
  const an = $("#anPlenum");
  buildSeats(an, S.members, false);
  const pairs = {};
  for (const s of sp) for (const t of s.addressedTo) pairs[`${s.mkId}>${t}`] = (pairs[`${s.mkId}>${t}`] ?? 0) + 1;
  const lines = Object.entries(pairs).map(([k, n]) => {
    const [from, to] = k.split(">");
    return { from, to, w: 1.5 + n * 1.5, title: `${name(from)} → ${name(to)}: ${n}` };
  });
  const hp = {};
  for (const h of heckles) {
    const target = sp.find((s) => s.id === h.speechId)?.mkId;
    if (target) hp[`${h.mkId}>${target}`] = (hp[`${h.mkId}>${target}`] ?? 0) + 1;
  }
  for (const [k, n] of Object.entries(hp)) {
    const [from, to] = k.split(">");
    lines.push({ from, to, w: 1 + n, dashed: true, title: `📢 ${name(from)} → ${name(to)}: ${n}` });
  }
  drawLinks($("#anLinks"), S.members, lines);

  // timeline
  const maxW = Math.max(1, ...sp.map((s) => words(s.text)));
  $("#timeline").innerHTML = sp
    .map((s) => {
      const m = S.byId[s.mkId];
      const h = heckles.filter((x) => x.speechId === s.id).length;
      return `<div class="tl-row" title="${esc(s.text)}"><span class="muted">#${s.index + 1}</span><span class="lbl">${m.emoji} ${esc(m.name)}</span><span style="display:flex;gap:6px;align-items:center"><span class="bar" style="width:${(100 * words(s.text)) / maxW}%;background:${TONE_COLOR[s.tone] ?? "#999"}"></span><span class="small">${TONE[s.tone] ?? ""}${h ? ` · 📢${h}` : ""}</span></span></div>`;
    })
    .join("") || '<p class="muted">אין נאומים</p>';

  // airtime
  const air = {};
  for (const s of sp) air[s.mkId] = (air[s.mkId] ?? 0) + words(s.text);
  const maxA = Math.max(1, ...Object.values(air));
  $("#airtime").innerHTML = S.members
    .slice()
    .sort((a, b) => (air[b.id] ?? 0) - (air[a.id] ?? 0))
    .map((m) => `<div class="air-row"><span>${m.emoji} ${esc(m.name)}</span><span class="bar" style="width:${(100 * (air[m.id] ?? 0)) / maxA}%;background:${m.color}"></span><span class="small muted">${air[m.id] ?? 0}</span></div>`)
    .join("");

  // stance journey + final vote
  $("#stances").innerHTML = S.members
    .map((m) => {
      const chain = sp.filter((s) => s.mkId === m.id).map((s) => `<span class="st ${s.stance}">${STANCE[s.stance]}</span>`).join(" → ");
      const b = S.ballots.find((x) => x.mkId === m.id);
      return `<div class="stance-row"><span class="nm">${m.emoji} ${esc(m.name)}</span>${chain || '<span class="muted small">לא דיבר</span>'}${b ? ` ⟹ <b>${VOTE[b.vote]}</b>` : ""}</div>`;
    })
    .join("");
}
