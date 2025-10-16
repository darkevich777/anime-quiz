const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = parseInt(params.get("chat_id"));
const user_id = parseInt(params.get("user_id"));

const app = document.getElementById("content");

// === Константы синхронизации ===
const POLL_INTERVAL_MS = 3000;     // редкий фоновый опрос при активном раунде
const DEADLINE_SLOP_MS = 300;      // фора к дедлайну
const LOCAL_TIMER_MS = 250;        // частота мягкого обновления прогресс-бара

let lastState = null;
let lastRev = null;
let inFlight = false;
let lastAbort = null;
let pollTimer = null;
let deadlineTimer = null;
let localTimer = null;
let pendingAction = false;
let chosenTimer = 30; // дефолт до сохранения админом

function nowSec() { return Date.now()/1000; }
function fmtSec(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s/60);
  const r = s%60;
  return m>0 ? `${m}:${String(r).padStart(2,"0")}` : `${r}с`;
}

function renderErrorInit() {
  app.innerHTML = `
    <div class="text-center">
      <p class="text-xl mb-2">Неверные параметры запуска.</p>
      <p class="text-sm text-gray-300">Пожалуйста, откройте квиз через кнопку в личных сообщениях бота.</p>
    </div>
  `;
}

function progressBar(remain, total) {
  const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
  return `
    <div class="w-full bg-purple-900/50 rounded-full h-3">
      <div id="timerBar" class="h-3 rounded-full bg-purple-400 transition-all" style="width:${pct}%"></div>
    </div>
    <div id="timerRemain" class="text-xs text-gray-300 mt-1">Осталось: ${fmtSec(remain)}</div>
  `;
}

function buttonPrimary(id, label, disabled=false) {
  return `<button id="${id}" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}
function buttonGhost(id, label, disabled=false) {
  return `<button id="${id}" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}
function optionButton(text, idx, disabled=false, correct=false) {
  const base = "option py-3 px-4 rounded-lg transition text-left";
  let bg = "bg-purple-700 hover:bg-purple-600";
  if (correct) bg = "bg-green-700";
  if (disabled) bg += " opacity-70 cursor-not-allowed";
  return `<button class="${base} ${bg}" data-idx="${idx}" ${disabled?'disabled':''}>${text}</button>`;
}

function renderLoading(msg="Загрузка..."){
  app.innerHTML = `<p class="text-lg">${msg}</p>`;
}

function startPolling(intervalMs=POLL_INTERVAL_MS){
  if (pollTimer) return;
  pollTimer = setInterval(()=> getState({soft:true}), intervalMs);
}
function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}
function setDeadlineTimer(deadline){
  if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }
  const delay = Math.max(0, (deadline - nowSec())*1000 + DEADLINE_SLOP_MS);
  deadlineTimer = setTimeout(()=> getState({soft:true}), delay);
}
function startLocalTimer(deadline, total){
  stopLocalTimer();
  localTimer = setInterval(()=>{
    const remain = Math.max(0, deadline - nowSec());
    const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
    const bar = document.getElementById("timerBar");
    const rem = document.getElementById("timerRemain");
    if (bar) bar.style.width = `${pct}%`;
    if (rem) rem.textContent = `Осталось: ${fmtSec(remain)}`;
    if (remain <= 0) stopLocalTimer();
  }, LOCAL_TIMER_MS);
}
function stopLocalTimer(){
  if (localTimer){ clearInterval(localTimer); localTimer = null; }
}

function isAnswered(state){
  const me = state.players?.[String(user_id)];
  return !!me?.answered;
}

async function apiGetState(signal){
  const res = await fetch(`/api/get_state?chat_id=${chat_id}&user_id=${user_id}`, { signal });
  return res.json();
}
async function postJSON(url, body){
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  return res.json();
}

function renderAdmin(state){
  const rnd = state.round;
  const q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  const controls = `
    <div class="p-3 bg-purple-900 rounded-lg space-y-2">
      <div class="text-sm text-gray-300">Таймер вопроса (сек):</div>
      <div class="grid grid-cols-4 gap-2">
        ${[15,30,45,60].map(s => `
          <button class="timer btn py-2 rounded-lg ${state.timer_seconds===s?'bg-purple-600':'bg-purple-800 hover:bg-purple-700'}" data-s="${s}">${s}</button>
        `).join("")}
      </div>
      ${buttonPrimary("saveTimer","💾 Сохранить таймер", pendingAction)}
      <div class="grid grid-cols-3 gap-2 pt-2">
        ${buttonPrimary("startRound","▶ Начать квиз / вопрос", pendingAction)}
        ${buttonGhost("nextRound","⏭ Следующий вопрос", pendingAction || !state.round || !state.round.finished)}
        ${buttonGhost("endQuiz","🛑 Завершить квиз", pendingAction)}
      </div>
      <div class="text-xs text-gray-400">Админ тоже может отвечать.</div>
    </div>
  `;

  let body = "";
  if (!q){
    body = `
      <div class="text-center">
        <p class="text-xl mb-2">⏳ Вопрос ещё не начат.</p>
        <p class="text-sm text-gray-300">Игроков: ${playersCount}</p>
      </div>
    `;
  }else{
    const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
    const total = (state.timer_seconds || 1);
    const optsHtml = q.options.map((opt, i) => {
      const correct = rnd?.finished ? (i === q.answer) : false;
      return optionButton(opt, i, isAnswered(state), correct);
    }).join("");
    body = `
      <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
      <div class="grid grid-cols-1 gap-3 mb-4">${optsHtml}</div>
      ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
      <div class="text-sm text-gray-300 mt-2">
        Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
      </div>
    `;
  }

  app.innerHTML = `
    <h2 class="text-xl mb-4">👑 Панель администратора</h2>
    ${controls}
    <div class="mt-4 p-3 bg-purple-800/40 rounded-lg">${body}</div>
  `;

  // handlers
  document.querySelectorAll(".timer").forEach(b=>{
    b.onclick = () => {
      chosenTimer = parseInt(b.dataset.s);
      document.querySelectorAll(".timer").forEach(x=>x.classList.remove("bg-purple-600"));
      b.classList.add("bg-purple-600");
    };
  });

  const saveTimerBtn = document.getElementById("saveTimer");
  if (saveTimerBtn) saveTimerBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/config", {chat_id, user_id, timer_seconds: chosenTimer});
    pendingAction = false;
    if (r.ok) getState({soft:false});
  };

  const startBtn = document.getElementById("startRound");
  if (startBtn) startBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    // если таймер ещё не выставлен — подсейвим автоматически
    if (!lastState?.timer_seconds){
      const c = await postJSON("/api/admin/config", {chat_id, user_id, timer_seconds: chosenTimer});
      if (!c.ok){ pendingAction = false; return; }
    }
    const r = await postJSON("/api/admin/start", {chat_id, user_id, timer_seconds: chosenTimer});
    pendingAction = false;
    if (r.ok) getState({soft:false});
  };

  const nextBtn = document.getElementById("nextRound");
  if (nextBtn) nextBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/next", {chat_id, user_id});
    pendingAction = false;
    if (r.ok) getState({soft:false});
  };

  const endBtn = document.getElementById("endQuiz");
  if (endBtn) endBtn.onclick = async ()=>{
    if (!confirm("Завершить квиз и показать результаты?")) return;
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/end", {chat_id, user_id});
    pendingAction = false;
    if (r.ok) {
      stopPolling();
      stopLocalTimer();
      lastState = {...(lastState||{}), finalBoard: r.leaderboard || []};
      renderFinalBoard(r.leaderboard || []);
    } else {
      getState({soft:false});
    }
  };

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });

  // локальный таймер (без перерендера)
  if (state.round && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
  } else {
    stopLocalTimer();
  }
}

function renderPlayer(state){
  const rnd = state.round;
  const q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  if (!q){
    app.innerHTML = `
      <div class="text-center">
        <p class="text-xl mb-2">⏳ Ждём начала вопроса...</p>
        <div class="text-sm text-gray-300">Игроков: ${playersCount}</div>
      </div>
    `;
    stopLocalTimer();
    return;
  }

  const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
  const total = (state.timer_seconds || 1);
  const optsHtml = q.options.map((opt, i) => {
    const correct = rnd?.finished ? (i === q.answer) : false;
    return optionButton(opt, i, isAnswered(state), correct);
  }).join("");

  app.innerHTML = `
    <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
    <div class="grid grid-cols-1 gap-3 mb-4">${optsHtml}</div>
    ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
    <div class="text-sm text-gray-300 mt-2">
      Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
    </div>
  `;

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });

  if (state.round && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
  } else {
    stopLocalTimer();
  }
}

function renderFinalBoard(board){
  stopLocalTimer();
  if (!board || board.length===0){
    app.innerHTML = `
      <div class="text-center">
        <p class="text-xl mb-2">Квиз завершён!</p>
        <p>Участников не было 🤷‍♂️</p>
      </div>
    `;
    return;
  }
  const medals = ["🥇","🥈","🥉"];
  const rows = board.map((it, idx)=>`
    <div class="flex items-center justify-between py-2 px-3 bg-purple-900/50 rounded-lg">
      <div>${medals[idx] || "🎖️"}</div>
      <div class="font-semibold">${it.name}</div>
      <div>${it.score} балл(ов)</div>
      <div class="text-sm text-gray-300">${Number(it.total_time).toFixed(2)} сек</div>
    </div>
  `).join("");

  app.innerHTML = `
    <h2 class="text-xl mb-4">🏁 Итоги квиза</h2>
    <div class="space-y-2">${rows}</div>
    <div class="mt-4 text-sm text-gray-300">При равенстве очков победил(и) тот(те), кто затратил меньше суммарного времени.</div>
  `;
}

// --- Синхронизация состояния ---
async function getState(opts={}){
  if (inFlight) return;
  try{
    inFlight = true;
    if (lastAbort) lastAbort.abort();
    lastAbort = new AbortController();

    const data = await apiGetState(lastAbort.signal);

    if (data.ended){
      stopPolling();
      stopLocalTimer();
      if (lastState?.finalBoard) renderFinalBoard(lastState.finalBoard);
      else renderLoading("Квиз завершён.");
      return;
    }
    if (!data.ok){ renderLoading("Игра не найдена."); return; }

    if (data.rev !== lastRev || !opts.soft){
      lastRev = data.rev;
      lastState = data;

      if (data.round && !data.round.finished) startPolling(POLL_INTERVAL_MS);
      else stopPolling();

      if (data.round && !data.round.finished){
        setDeadlineTimer(data.round.deadline);
      }else{
        if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }
      }

      if (data.role === "admin") renderAdmin(data);
      else renderPlayer(data);
    }
  }catch(e){
    // игнорируем AbortError
  }finally{
    inFlight = false;
  }
}

async function submitAnswer(e){
  const idx = parseInt(e.target.dataset.idx);
  if (isNaN(idx)) return;
  document.querySelectorAll(".option").forEach(b=>b.setAttribute("disabled","disabled"));
  try{
    const r = await postJSON("/api/submit", {
      chat_id,
      user: { id: user_id },
      given: idx
    });
    if (r.ok) getState({soft:false});
    else document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
  }catch(err){
    document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
  }
}

// --- Точка входа ---
if (Number.isNaN(chat_id) || Number.isNaN(user_id)) {
  renderErrorInit();
} else {
  renderLoading();
  getState({soft:false});
}
