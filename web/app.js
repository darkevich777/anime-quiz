const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = parseInt(params.get("chat_id"));
const user_id = parseInt(params.get("user_id"));

const app = document.getElementById("content");

// === Константы синхронизации и UX ===
const POLL_INTERVAL_MS = 3000;
const DEADLINE_SLOP_MS = 300;
const LOCAL_TIMER_MS = 250;
const COUNTDOWN_SEC = 3;
const OPTIONS_MIN_HEIGHT_PX = 260; // стабилизируем высоту сетки вариантов

let lastState = null;
let lastRev = null;
let inFlight = false;
let lastAbort = null;
let pollTimer = null;
let deadlineTimer = null;
let localTimer = null;
let rematchTimer = null;

let pendingAction = false;
let chosenTimer = 30; // дефолт до сохранения админом
let countdownUntil = null; // timestamp конца обратного отсчёта
let currentBg = null;      // текущий URL фона
let netBadge = null;       // индикатор сети

// ====== Утилиты ======
function nowSec() { return Date.now()/1000; }
function fmtSec(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s/60);
  const r = s%60;
  return m>0 ? `${m}:${String(r).padStart(2,"0")}` : `${r}с`;
}
function ensureOverlay(){
  // градиент/затемнение для контраста + индикатор сети
  if (!document.getElementById("bg-shade")){
    const shade = document.createElement("div");
    shade.id = "bg-shade";
    Object.assign(shade.style, {
      position: "fixed", inset: "0", pointerEvents: "none",
      background: "linear-gradient(180deg, rgba(0,0,0,.45) 0%, rgba(0,0,0,.65) 100%)",
      zIndex: "0"
    });
    document.body.appendChild(shade);
  }
  if (!netBadge){
    netBadge = document.createElement("div");
    netBadge.id = "net-badge";
    netBadge.textContent = "Проблемы со связью…";
    Object.assign(netBadge.style, {
      position: "fixed", top: "8px", right: "8px",
      background: "rgba(255,255,255,.08)",
      border: "1px solid rgba(255,255,255,.18)",
      backdropFilter: "blur(6px)",
      padding: "6px 10px", borderRadius: "10px",
      fontSize: "12px", color: "#fff",
      opacity: "0", transition: "opacity .2s ease",
      zIndex: "1000"
    });
    document.body.appendChild(netBadge);
  }
}
function showNetBadge(on){
  if (!netBadge) return;
  netBadge.style.opacity = on ? "1" : "0";
}
function setBackground(url){
  ensureOverlay();
  // если нет новой картинки — не трогаем фон, чтобы не было чёрного экрана
  if (!url) return;
  if (url === currentBg) return;
  const img = new Image();
  img.onload = () => {
    currentBg = url;
    document.body.style.backgroundImage = `url("${url}")`;
    document.body.style.backgroundSize = "cover";
    document.body.style.backgroundPosition = "center";
    document.body.style.backgroundAttachment = "fixed";
    document.body.style.backgroundRepeat = "no-repeat";
  };
  img.src = url;
}

function progressBar(remain, total) {
  const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
  return `
    <div class="w-full bg-purple-900/50 rounded-full h-3">
      <div id="timerBar" class="h-3 rounded-full bg-purple-400 transition-all" style="width:${pct}%"></div>
    </div>
    <div id="timerRemain" class="text-xs text-gray-200 mt-1">Осталось: ${fmtSec(remain)}</div>
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

// ====== Поллинг / таймеры ======
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

// ====== API helpers (с ретраями для POST) ======
async function apiGetState(signal){
  const res = await fetch(`/api/get_state?chat_id=${chat_id}&user_id=${user_id}`, { signal });
  return res.json();
}
async function postJSON(url, body, {retries=2}={}){
  let attempt = 0;
  while (true){
    try{
      const res = await fetch(url, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!data.ok) throw new Error("server returned not ok");
      return data;
    }catch(e){
      if (attempt >= retries) throw e;
      attempt++;
      showNetBadge(true);
      await new Promise(r=>setTimeout(r, 300*attempt)); // бэкофф
    }finally{
      if (attempt === 0) showNetBadge(false);
      else setTimeout(()=>showNetBadge(false), 400);
    }
  }
}
async function apiRematchState(){
  const res = await fetch(`/api/rematch/state?chat_id=${chat_id}&user_id=${user_id}`);
  return res.json();
}

// ====== Рендеры ======
function renderAdmin(state){
  const rnd = state.round;
  const q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  // показываем блок таймера И кнопку «Начать…» только до первого раунда
  const firstScreen = !state.round;

  const timerBlock = firstScreen ? `
      <div class="p-3 bg-purple-900 rounded-lg space-y-2">
        <div class="text-sm text-gray-300">Таймер вопроса (сек):</div>
        <div class="grid grid-cols-4 gap-2">
          ${[15,30,45,60].map(s => `
            <button class="timer btn py-2 rounded-lg ${state.timer_seconds===s?'bg-purple-600':'bg-purple-800 hover:bg-purple-700'}" data-s="${s}">${s}</button>
          `).join("")}
        </div>
        ${buttonPrimary("saveTimer","💾 Сохранить таймер", pendingAction)}
      </div>
  ` : "";

  const controls = `
    <div class="p-3 bg-purple-900 rounded-lg space-y-2 mt-3">
      <div class="grid ${firstScreen ? 'grid-cols-1' : 'grid-cols-2'} gap-2">
        ${firstScreen ? buttonPrimary("startRound","▶ Начать квиз / вопрос", pendingAction) : ""}
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
    // обратный отсчёт
    const underCountdown = countdownUntil && nowSec() < countdownUntil;
    const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
    const total = (state.timer_seconds || 1);

    const optsHtml = underCountdown
      ? `<div class="text-center text-3xl py-10" id="cd">Начинаем через…</div>`
      : q.options.map((opt, i) => {
          const correct = rnd?.finished ? (i === q.answer) : false;
          return optionButton(opt, i, isAnswered(state), correct);
        }).join("");

    body = `
      <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
      <div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:${OPTIONS_MIN_HEIGHT_PX}px">${optsHtml}</div>
      ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
      <div class="text-sm text-gray-200 mt-2">
        Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
      </div>
    `;

    if (q.image) setBackground(q.image);
  }

  app.innerHTML = `
    <h2 class="text-xl mb-4">👑 Панель администратора</h2>
    ${timerBlock}
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
    try{
      await postJSON("/api/admin/config", {chat_id, user_id, timer_seconds: chosenTimer});
    }catch(e){} finally{
      pendingAction = false; getState({soft:false});
    }
  };

  const startBtn = document.getElementById("startRound");
  if (startBtn) startBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    try{
      if (!lastState?.timer_seconds){
        await postJSON("/api/admin/config", {chat_id, user_id, timer_seconds: chosenTimer});
      }
      await postJSON("/api/admin/start", {chat_id, user_id, timer_seconds: chosenTimer});
      // ставим обратный отсчёт
      countdownUntil = nowSec() + COUNTDOWN_SEC;
      tg?.HapticFeedback?.notificationOccurred?.('success');
    }catch(e){} finally{
      pendingAction = false; getState({soft:false});
    }
  };

  const nextBtn = document.getElementById("nextRound");
  if (nextBtn) nextBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    try{
      await postJSON("/api/admin/next", {chat_id, user_id});
      countdownUntil = nowSec() + COUNTDOWN_SEC;
      tg?.HapticFeedback?.impactOccurred?.('medium');
    }catch(e){} finally{
      pendingAction = false; getState({soft:false});
    }
  };

  const endBtn = document.getElementById("endQuiz");
  if (endBtn) endBtn.onclick = async ()=>{
    if (!confirm("Завершить квиз и показать результаты?")) return;
    pendingAction = true; renderAdmin(state);
    try{
      const r = await postJSON("/api/admin/end", {chat_id, user_id});
      stopPolling(); stopLocalTimer();
      renderFinalBoard(r.leaderboard || []);
      startRematchWatch();
      tg?.HapticFeedback?.notificationOccurred?.('success');
    }catch(e){
      getState({soft:false});
    }finally{
      pendingAction = false;
    }
  };

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });

  if (state.round && !state.round.finished){
    // локальный таймер
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
    // анимация обратного отсчёта, если активен
    if (countdownUntil && nowSec() < countdownUntil){
      const cdEl = document.getElementById("cd");
      const tick = ()=>{
        if (!cdEl) return;
        const remain = Math.ceil(countdownUntil - nowSec());
        if (remain > 0){
          cdEl.textContent = `Начинаем через: ${remain}`;
          requestAnimationFrame(tick);
        } else {
          // перерисуем, чтобы показать варианты
          countdownUntil = null;
          getState({soft:false});
        }
      };
      tick();
    }
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

  const underCountdown = countdownUntil && nowSec() < countdownUntil;
  const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
  const total = (state.timer_seconds || 1);

  const optsHtml = underCountdown
    ? `<div class="text-center text-3xl py-10" id="cd">Начинаем через…</div>`
    : q.options.map((opt, i) => {
        const correct = rnd?.finished ? (i === q.answer) : false;
        return optionButton(opt, i, isAnswered(state), correct);
      }).join("");

  app.innerHTML = `
    <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
    <div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:${OPTIONS_MIN_HEIGHT_PX}px">${optsHtml}</div>
    ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
    <div class="text-sm text-gray-200 mt-2">
      Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
    </div>
  `;

  if (q.image) setBackground(q.image);

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });

  if (state.round && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);

    if (underCountdown){
      const cdEl = document.getElementById("cd");
      const tick = ()=>{
        if (!cdEl) return;
        const r = Math.ceil(countdownUntil - nowSec());
        if (r > 0){
          cdEl.textContent = `Начинаем через: ${r}`;
          requestAnimationFrame(tick);
        } else {
          countdownUntil = null;
          getState({soft:false});
        }
      };
      tick();
    }
  } else {
    stopLocalTimer();
    // лёгкая вибрация при открытии правильного ответа
    if (q.answer !== undefined) tg?.HapticFeedback?.impactOccurred?.('light');
  }
}

function renderFinalBoard(board){
  stopLocalTimer();
  const medals = ["🥇","🥈","🥉"];
  const rows = (board||[]).map((it, idx)=>`
    <div class="flex items-center justify-between py-2 px-3 bg-purple-900/50 rounded-lg">
      <div>${medals[idx] || "🎖️"}</div>
      <div class="font-semibold">${it.name}</div>
      <div>${it.score} балл(ов)</div>
      <div class="text-sm text-gray-300">${Number(it.total_time).toFixed(2)} сек</div>
    </div>
  `).join("");

  const joinBtn = buttonPrimary("rematchJoin","🔁 Участвовать ещё раз");
  const adminPanel = `
    <div id="rematchAdmin" class="mt-4 p-3 bg-purple-900 rounded-lg hidden">
      <div class="text-sm mb-2">Подтвердили участие:</div>
      <div id="rematchList" class="space-y-1 text-sm"></div>
      <div class="mt-3">${buttonGhost("rematchStart","🚀 Перезапустить квиз")}</div>
    </div>
  `;

  app.innerHTML = `
    <h2 class="text-xl mb-4">🏁 Итоги квиза</h2>
    <div class="space-y-2">${rows || "<div>Участников не было 🤷‍♂️</div>"}</div>
    <div class="mt-6">${joinBtn}</div>
    ${adminPanel}
  `;

  document.getElementById("rematchJoin").onclick = async ()=>{
    try{
      const name = tg?.initDataUnsafe?.user?.first_name || "Игрок";
      await postJSON("/api/rematch/join", {chat_id, user_id, name});
      tg?.HapticFeedback?.notificationOccurred?.('success');
      updateRematchAdminUI();
    }catch(e){}
  };

  updateRematchAdminUI(true);
}

async function updateRematchAdminUI(forceShow=false){
  const data = await apiRematchState();
  const box = document.getElementById("rematchAdmin");
  if (!box) return;
  if (!data.ok) { box.classList.add("hidden"); return; }
  if (forceShow || data.admin_id === user_id){
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }
  const list = document.getElementById("rematchList");
  if (list){
    const items = Object.values(data.confirmed || {});
    list.innerHTML = items.length ? items.map(n=>`<div>• ${n}</div>`).join("") : "<div>— пока никто</div>";
  }
  const startBtn = document.getElementById("rematchStart");
  if (startBtn){
    startBtn.onclick = async ()=>{
      try{
        await postJSON("/api/rematch/start", {chat_id, user_id});
        renderLoading("Запуск новой игры…");
        if (rematchTimer){ clearInterval(rematchTimer); rematchTimer=null; }
        tg?.HapticFeedback?.notificationOccurred?.('success');
        getState({soft:false});
      }catch(e){}
    };
  }
}

function startRematchWatch(){
  if (rematchTimer) clearInterval(rematchTimer);
  rematchTimer = setInterval(updateRematchAdminUI, 2000);
}

// ====== Синхронизация состояния ======
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
      const rs = await apiRematchState();
      if (rs.ok){
        renderFinalBoard(rs.leaderboard || []);
        startRematchWatch();
      } else {
        renderLoading("Квиз завершён.");
      }
      return;
    }
    if (!data.ok){ renderLoading("Игра не найдена."); return; }

    // если начался НОВЫЙ раунд (смена rev и появился другой вопрос) — ставим обратный отсчёт
    const newQuestionAppeared = (data.round && (!lastState?.round || data.round.started_at !== lastState.round.started_at));
    if (newQuestionAppeared){
      countdownUntil = nowSec() + COUNTDOWN_SEC;
    }

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
    await postJSON("/api/submit", {
      chat_id,
      user: { id: user_id },
      given: idx
    });
    tg?.HapticFeedback?.impactOccurred?.('light');
    getState({soft:false});
  }catch(err){
    document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
  }
}

// ====== Точка входа ======
if (Number.isNaN(chat_id) || Number.isNaN(user_id)) {
  app.innerHTML = `
    <div class="text-center">
      <p class="text-xl mb-2">Неверные параметры запуска.</p>
      <p class="text-sm text-gray-300">Откройте квиз через кнопку в личных сообщениях бота.</p>
    </div>
  `;
} else {
  ensureOverlay();
  renderLoading();
  getState({soft:false});
}
