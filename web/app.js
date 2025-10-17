// ===== Mini App — стабильный отсчёт 3..2..1, плюс выбор раундов и улучшения рематча =====
const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = parseInt(params.get("chat_id"));
const user_id = parseInt(params.get("user_id"));

const app = document.getElementById("content");

// === Константы ===
const POLL_INTERVAL_MS = 3000;
const DEADLINE_SLOP_MS = 300;
const LOCAL_TIMER_MS = 250;
const COUNTDOWN_SEC = 3;
const COUNTDOWN_SKIP_THRESHOLD = 0.2;
const PRELOAD_WAIT_CAP_MS = 800;
const OPTIONS_MIN_HEIGHT_PX = 260;

let lastState = null;
let lastRev = null;
let inFlight = false;
let lastAbort = null;
let pollTimer = null;
let deadlineTimer = null;
let localTimer = null;
let rematchTimer = null;

let chosenTimer = 30;
let chosenRounds = 10;                 // <- по умолчанию 10 раундов
let currentBg = null;

// --- состояние отсчёта/предзагрузки ---
let countdownActive = false;
let countdownEndTs = 0;
let countdownRaf = null;
let countdownHardTimeout = null;
let nextQImageUrl = null;
let nextQImageReady = false;
let countingStartedAt = null;

// ---------- Утилиты ----------
function nowSec(){ return Date.now()/1000; }
function fmtSec(s){
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s/60), r = s%60;
  return m>0 ? `${m}:${String(r).padStart(2,"0")}` : `${r}с`;
}
function renderLoading(msg="Загрузка..."){ app.innerHTML = `<p class="text-lg">${msg}</p>`; }
function scrollTop(){ try{ window.scrollTo({top:0, behavior:"instant"}); }catch{} }

// Стартовый фон
function resetBackgroundToDefault(){
  currentBg = null;
  document.documentElement.style.setProperty('background-image', 'none', 'important');
  document.body.style.setProperty('background-image', 'none', 'important');
  document.documentElement.style.setProperty('background', '#0b0220', 'important');
  document.body.style.setProperty('background', '#0b0220', 'important');
}

// Надёжная смена фона
function setBackground(url){
  if (!url || url === currentBg) return;
  const img = new Image();
  img.onload = () => {
    currentBg = url;
    document.documentElement.style.setProperty('background-image', `url("${url}")`, 'important');
    document.documentElement.style.setProperty('background-repeat', 'no-repeat', 'important');
    document.documentElement.style.setProperty('background-position', 'center', 'important');
    document.documentElement.style.setProperty('background-size', 'cover', 'important');
    document.documentElement.style.setProperty('background-attachment', 'fixed', 'important');
    document.body.style.setProperty('background-image', `url("${url}")`, 'important');
    document.body.style.setProperty('background-repeat', 'no-repeat', 'important');
    document.body.style.setProperty('background-position', 'center', 'important');
    document.body.style.setProperty('background-size', 'cover', 'important');
    document.body.style.setProperty('background-attachment', 'fixed', 'important');
  };
  img.src = url;
}
function preloadImage(url){
  return new Promise(resolve=>{
    if (!url){ resolve(true); return; }
    const img = new Image();
    img.onload = ()=> resolve(true);
    img.onerror = ()=> resolve(false);
    img.src = url;
  });
}

// ---------- Таймеры ----------
function startPolling(i=POLL_INTERVAL_MS){ if (!pollTimer) pollTimer = setInterval(()=>getState({soft:true}), i); }
function stopPolling(){ if (pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

function setDeadlineTimer(deadline){
  if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }
  const delay = Math.max(0, (deadline - nowSec())*1000 + DEADLINE_SLOP_MS);
  deadlineTimer = setTimeout(()=> getState({soft:true}), delay);
}

function startLocalTimer(deadline, total){
  stopLocalTimer();
  localTimer = setInterval(()=>{
    const remain = Math.max(0, deadline - nowSec());
    const bar = document.getElementById("timerBar");
    const rem = document.getElementById("timerRemain");
    if (bar){
      const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
      bar.style.width = `${pct}%`;
    }
    if (rem) rem.textContent = `Осталось: ${fmtSec(remain)}`;
    if (remain <= 0) stopLocalTimer();
  }, LOCAL_TIMER_MS);
}
function stopLocalTimer(){ if (localTimer){ clearInterval(localTimer); localTimer=null; } }

// ---------- API ----------
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
async function apiRematchState(){
  const res = await fetch(`/api/rematch/state?chat_id=${chat_id}&user_id=${user_id}`);
  return res.json();
}

// ---------- Виджеты ----------
function progressBar(remain, total){
  const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
  return `
    <div class="w-full bg-purple-900/40 rounded-full h-3">
      <div id="timerBar" class="h-3 rounded-full bg-purple-400 transition-all" style="width:${pct}%"></div>
    </div>
    <div id="timerRemain" class="text-xs text-gray-100 mt-1">Осталось: ${fmtSec(remain)}</div>
  `;
}
function buttonPrimary(id, label, disabled=false){
  return `<button id="${id}" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}
function buttonGhost(id, label, disabled=false){
  return `<button id="${id}" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}
function optionButton(text, idx, disabled=false, correct=false){
  const base="option py-3 px-4 rounded-lg transition text-left";
  let bg="bg-purple-700 hover:bg-purple-600";
  if (correct) bg = "bg-green-700";
  if (disabled) bg += " opacity-70 cursor-not-allowed";
  return `<button class="${base} ${bg}" data-idx="${idx}" ${disabled?'disabled':''}>${text}</button>`;
}
function isAnswered(state){
  const me = state.players?.[String(user_id)];
  return !!me?.answered;
}

// ---------- Экран отсчёта ----------
function showCountdownScreen(){
  app.innerHTML = `
    <div class="flex items-center justify-center" style="min-height:60vh">
      <div class="text-center">
        <div class="text-xl mb-2">Готовимся к следующему вопросу…</div>
        <div id="cdVal" class="text-6xl font-semibold">3</div>
      </div>
    </div>
  `;
}
function clearCountdown(){
  countdownActive = false;
  countingStartedAt = null;
  if (countdownRaf) cancelAnimationFrame(countdownRaf);
  countdownRaf = null;
  if (countdownHardTimeout) clearTimeout(countdownHardTimeout);
  countdownHardTimeout = null;
}
function startCountdownForQuestion(startedAt, imageUrl){
  if (countdownActive && countingStartedAt === startedAt) return;

  const serverEnd = startedAt + COUNTDOWN_SEC;
  const timeLeft = serverEnd - nowSec();

  // поздно пришли — пропускаем отсчёт
  if (timeLeft <= COUNTDOWN_SKIP_THRESHOLD){
    if (imageUrl) preloadImage(imageUrl).then(()=> setBackground(imageUrl));
    clearCountdown();
    setTimeout(()=>getState({soft:false}), 0);
    return;
  }

  countdownActive = true;
  countingStartedAt = startedAt;
  countdownEndTs = serverEnd;
  nextQImageUrl = imageUrl || null;
  nextQImageReady = false;

  preloadImage(nextQImageUrl).then(ok => { nextQImageReady = ok || !imageUrl; });

  resetBackgroundToDefault();
  showCountdownScreen();

  const tick = ()=>{
    if (!countdownActive || countingStartedAt !== startedAt) return;
    const left = Math.ceil(countdownEndTs - nowSec());
    const el = document.getElementById("cdVal");
    if (el) el.textContent = String(Math.max(0, left));
    if (left <= 0){
      finishCountdownAndShowQuestion();
    } else {
      countdownRaf = requestAnimationFrame(tick);
    }
  };
  countdownRaf = requestAnimationFrame(tick);

  countdownHardTimeout = setTimeout(()=>{
    if (countdownActive && countingStartedAt === startedAt) finishCountdownAndShowQuestion();
  }, COUNTDOWN_SEC*1000 + PRELOAD_WAIT_CAP_MS + 300);
}
function finishCountdownAndShowQuestion(){
  const waitUntil = Date.now() + PRELOAD_WAIT_CAP_MS;
  const waitLoop = ()=>{
    if (!countdownActive) return;
    if (nextQImageReady || Date.now() > waitUntil){
      if (nextQImageUrl) setBackground(nextQImageUrl);
      clearCountdown();
      getState({soft:false});
    } else {
      setTimeout(waitLoop, 50);
    }
  };
  waitLoop();
}
function maybeDismissCountdownByState(data){
  if (!countdownActive) return;
  const sameRound = data.round && data.round.started_at === countingStartedAt;
  const roundOngoing = data.round && !data.round.finished && (data.round.deadline - nowSec() > 0);
  const timeLeft = countdownEndTs - nowSec();
  if (sameRound && (timeLeft <= 0.05 || roundOngoing)){
    if (nextQImageUrl){
      if (nextQImageReady) setBackground(nextQImageUrl);
      else setTimeout(()=>setBackground(nextQImageUrl), 0);
    }
    clearCountdown();
  }
}

// ---------- Рендеры ----------
function renderAdmin(state){
  const rnd = state.round, q = state.question;
  const playersCount = Object.keys(state.players||{}).length;
  const firstScreen = !state.round;

  // --- Блок настроек до старта: таймер + количество раундов ---
  const settingsBlock = firstScreen ? `
    <div class="p-3 bg-purple-900/40 rounded-lg space-y-2 border border-white/10">
      <div class="text-sm text-gray-100">Таймер вопроса (сек):</div>
      <div class="grid grid-cols-4 gap-2">
        ${[15,30,45,60].map(s=>`
          <button class="timer btn py-2 rounded-lg ${state.timer_seconds===s?'bg-purple-600':''}" data-s="${s}">${s}</button>
        `).join("")}
      </div>
      <div class="text-sm text-gray-100 mt-3">Количество раундов:</div>
      <div class="grid grid-cols-4 gap-2">
        ${[10,15,20,30].map(n=>`
          <button class="rounds btn py-2 rounded-lg ${ (state.rounds_total||10)===n ? 'bg-purple-600':''}" data-n="${n}">${n}</button>
        `).join("")}
      </div>
      ${buttonPrimary("saveSettings","💾 Сохранить настройки")}
    </div>
  ` : "";

  const controls = `
    <div class="p-3 bg-purple-900/40 rounded-lg space-y-2 mt-3 border border-white/10">
      <div class="grid ${firstScreen ? 'grid-cols-1' : 'grid-cols-2'} gap-2">
        ${firstScreen ? buttonPrimary("startRound","▶ Начать квиз") : ""}
        ${buttonGhost("nextRound","⏭ Следующий вопрос", !state.round || !state.round.finished)}
        ${buttonGhost("endQuiz","🛑 Завершить квиз")}
      </div>
      <div class="text-xs text-gray-100">Админ тоже может отвечать.</div>
    </div>
  `;

  if (countdownActive){
    app.innerHTML = `<h2 class="text-xl mb-4">👑 Панель администратора</h2>${settingsBlock}${controls}`;
    showCountdownScreen();
    return;
  }

  let body = "";
  if (!q){
    body = `
      <div class="p-3 bg-purple-800/30 rounded-lg border border-white/10 text-center">
        <p class="text-xl mb-2">🎮 Квиз ещё не начался!</p>
        <p class="text-sm text-gray-100">Игроков: ${playersCount}</p>
      </div>
    `;
  } else {
    const remain = Math.max(0, (rnd?.deadline||0) - nowSec());
    const total = (state.timer_seconds||1);
    const finished = !!(state.round && state.round.finished && typeof q.answer === "number");
    const optsHtml = q.options.map((opt,i)=>{
      const correct = finished && (i===q.answer);
      const disabled = isAnswered(state) || finished;
      return optionButton(opt, i, disabled, correct);
    }).join("");
    body = `
      <div class="mt-4 p-3 bg-purple-800/30 rounded-lg border border-white/10">
        <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
        <div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:${OPTIONS_MIN_HEIGHT_PX}px">${optsHtml}</div>
        ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
        <div class="text-sm text-gray-100 mt-2">
          Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
        </div>
      </div>
    `;
    if (q.image) setBackground(q.image);
  }

  app.innerHTML = `
    <h2 class="text-xl mb-4">👑 Панель администратора</h2>
    ${settingsBlock}
    ${controls}
    ${body}
  `;
  scrollTop();

  // ----- handlers -----
  document.querySelectorAll(".timer").forEach(b=>{
    b.onclick = ()=>{
      chosenTimer = parseInt(b.dataset.s);
      document.querySelectorAll(".timer").forEach(x=>x.classList.remove("bg-purple-600"));
      b.classList.add("bg-purple-600");
    };
  });
  document.querySelectorAll(".rounds").forEach(b=>{
    b.onclick = ()=>{
      chosenRounds = parseInt(b.dataset.n);
      document.querySelectorAll(".rounds").forEach(x=>x.classList.remove("bg-purple-600"));
      b.classList.add("bg-purple-600");
    };
  });

  const saveSettingsBtn = document.getElementById("saveSettings");
  if (saveSettingsBtn) saveSettingsBtn.onclick = async ()=>{
    saveSettingsBtn.disabled = true;
    const r = await postJSON("/api/admin/config", {
      chat_id, user_id,
      timer_seconds: chosenTimer,
      rounds_total: chosenRounds
    }).catch(()=>({ok:false}));
    saveSettingsBtn.disabled = false;
    if (r.ok) getState({soft:false});
  };

  const startBtn = document.getElementById("startRound");
  if (startBtn) startBtn.onclick = async ()=>{
    startBtn.disabled = true;
    try{
      const c = await postJSON("/api/admin/config", {
        chat_id, user_id,
        timer_seconds: chosenTimer,
        rounds_total: chosenRounds
      });
      if (!c.ok) { startBtn.disabled=false; return; }
      const r = await postJSON("/api/admin/start", {
        chat_id, user_id,
        timer_seconds: chosenTimer   // на всякий случай дублируем
      });
      if (r.ok) getState({soft:false});
    } finally { startBtn.disabled = false; }
  };

  const nextBtn = document.getElementById("nextRound");
  if (nextBtn) nextBtn.onclick = async ()=>{
    if (nextBtn.disabled) return;
    nextBtn.disabled = true;
    try{
      const r = await postJSON("/api/admin/next", {chat_id, user_id});
      if (r.ok) getState({soft:false});
    } finally { nextBtn.disabled = false; }
  };

  const endBtn = document.getElementById("endQuiz");
  if (endBtn) endBtn.onclick = async ()=>{
    // 5) без доп. подтверждения
    endBtn.disabled = true;
    try{
      const r = await postJSON("/api/admin/end", {chat_id, user_id});
      if (r.ok){
        stopPolling(); stopLocalTimer();
        renderFinalBoard(r.leaderboard || []);
        startRematchWatch();
      }
    } finally { endBtn.disabled = false; }
  };

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });

  if (state.round && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
  } else {
    stopLocalTimer();
  }
}

function renderPlayer(state){
  const rnd = state.round, q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  if (countdownActive){
    showCountdownScreen();
    return;
  }

  if (!q){
    app.innerHTML = `
      <div class="p-3 bg-purple-800/30 rounded-lg border border-white/10 text-center">
        <p class="text-xl mb-2">🎮 Квиз ещё не начался!</p>
        <p class="text-sm text-gray-100">Игроков: ${playersCount}</p>
      </div>
    `;
    stopLocalTimer(); scrollTop();
    return;
  }

  const remain = Math.max(0, (rnd?.deadline||0) - nowSec());
  const total = (state.timer_seconds||1);
  const finished = !!(state.round && state.round.finished && typeof q.answer === "number");

  const optsHtml = q.options.map((opt,i)=>{
    const correct = finished && (i===q.answer);
    const disabled = isAnswered(state) || finished;
    return optionButton(opt, i, disabled, correct);
  }).join("");

  app.innerHTML = `
    <div class="mt-4 p-3 bg-purple-800/30 rounded-lg border border-white/10">
      <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
      <div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:${OPTIONS_MIN_HEIGHT_PX}px">${optsHtml}</div>
      ${rnd ? `<div class="mt-2">${progressBar(remain, total)}</div>` : ""}
      <div class="text-sm text-gray-100 mt-2">
        Ответили: ${Object.values(state.players||{}).filter(p=>p.answered).length}/${playersCount}
      </div>
    </div>
  `;
  scrollTop();

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
  resetBackgroundToDefault();
  stopLocalTimer();

  const medals=["🥇","🥈","🥉"];
  const rows = (board||[]).map((it,idx)=>`
    <div class="flex items-center justify-between py-2 px-3 bg-purple-900/30 rounded-lg border border-white/10">
      <div>${medals[idx] || "🎖️"}</div>
      <div class="font-semibold">${it.name}</div>
      <div>${it.score} балл(ов)</div>
      <div class="text-sm text-gray-200">${Number(it.total_time).toFixed(2)} сек</div>
    </div>
  `).join("");

  // 2) Тоггл участия: участвовать ↔ отменить участие
  const joinToggleBtn = `<button id="rematchToggle" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition">🔁 Участвовать ещё раз</button>`;

  // 4) "Перезапустить" неактивна до 1 подтверждённого
  const adminPanel = `
    <div id="rematchAdmin" class="mt-4 p-3 bg-purple-900/30 rounded-lg border border-white/10 hidden">
      <div class="text-sm mb-2">Подтвердили участие:</div>
      <div id="rematchList" class="space-y-1 text-sm"></div>
      <div class="mt-3"><button id="rematchStart" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition" disabled>🚀 Перезапустить квиз</button></div>
    </div>
  `;

  app.innerHTML = `
    <h2 class="text-xl mb-4">🏁 Итоги квиза</h2>
    <div class="space-y-2">${rows || "<div>Участников не было 🤷‍♂️</div>"}</div>
    <div class="mt-6">${joinToggleBtn}</div>
    ${adminPanel}
  `;

  document.getElementById("rematchToggle").onclick = async ()=>{
    try{
      // узнаём текущее состояние, чтобы понять — мы в списке или нет
      const s = await apiRematchState();
      const inList = s.ok && s.confirmed && s.confirmed[String(user_id)];
      if (inList){
        await postJSON("/api/rematch/leave", {chat_id, user_id}).catch(()=>({ok:false}));
      } else {
        const name = tg?.initDataUnsafe?.user?.first_name || "Игрок";
        await postJSON("/api/rematch/join", {chat_id, user_id, name}).catch(()=>({ok:false}));
      }
      updateRematchAdminUI();
    }catch(e){}
  };

  updateRematchAdminUI(true);
}

async function updateRematchAdminUI(forceShow=false){
  const data = await apiRematchState();
  const box = document.getElementById("rematchAdmin");
  if (!box) return;
  if (!data.ok){ box.classList.add("hidden"); return; }

  // показывать админ-панель только админу
  if (forceShow || data.admin_id === user_id) box.classList.remove("hidden"); else box.classList.add("hidden");

  // список подтверждений
  const list = document.getElementById("rematchList");
  const items = Object.values(data.confirmed || {});
  if (list){
    list.innerHTML = items.length ? items.map(n=>`<div>• ${n}</div>`).join("") : "<div>— пока никто</div>";
  }

  // 4) активируем старт только при >=1
  const startBtn = document.getElementById("rematchStart");
  if (startBtn){
    startBtn.disabled = !(items.length >= 1);
    startBtn.onclick = async ()=>{
      if (startBtn.disabled) return;
      const r = await postJSON("/api/rematch/start", {chat_id, user_id}).catch(()=>({ok:false}));
      if (r.ok){
        if (rematchTimer){ clearInterval(rematchTimer); rematchTimer=null; }
        renderLoading("Запуск новой игры…");
        getState({soft:false});
      }
    };
  }

  // 2) текст кнопки для своего статуса
  const toggle = document.getElementById("rematchToggle");
  if (toggle){
    const inList = data.confirmed && data.confirmed[String(user_id)];
    toggle.textContent = inList ? "✖️ Отменить участие" : "🔁 Участвовать ещё раз";
  }
}
function startRematchWatch(){
  if (rematchTimer) clearInterval(rematchTimer);
  rematchTimer = setInterval(updateRematchAdminUI, 2000);
}

// ---------- Синхронизация ----------
async function getState(opts={}){
  if (inFlight) return;
  try{
    inFlight = true;
    if (lastAbort) lastAbort.abort();
    lastAbort = new AbortController();

    const data = await apiGetState(lastAbort.signal);

    if (data.ended){
      stopPolling(); stopLocalTimer();
      const rs = await apiRematchState();
      if (rs.ok){
        renderFinalBoard(rs.leaderboard || []);
        startRematchWatch();
      } else {
        renderLoading("Квиз завершён.");
        resetBackgroundToDefault();
      }
      return;
    }
    if (!data.ok){ renderLoading("Игра не найдена."); return; }

    // если видим, что раунд уже идёт — снимем отсчёт
    maybeDismissCountdownByState(data);

    // детект нового вопроса
    const startedAt = data.round?.started_at;
    const newQuestion = startedAt && (!lastState?.round || startedAt !== lastState.round.started_at);

    if (newQuestion){
      const imgUrl = data.question?.image || null;
      startCountdownForQuestion(startedAt, imgUrl);
    }

    // обновляем локальное состояние/таймеры
    if (data.rev !== lastRev || !opts.soft || newQuestion){
      lastRev = data.rev;
      lastState = data;

      // подхватываем текущие настройки (если пришли из бекэнда)
      if (data.timer_seconds) chosenTimer = data.timer_seconds;
      if (data.rounds_total) chosenRounds = data.rounds_total;

      if (data.round && !data.round.finished) startPolling(POLL_INTERVAL_MS);
      else stopPolling();

      if (data.round && !data.round.finished) setDeadlineTimer(data.round.deadline);
      else if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }

      if (countdownActive){
        showCountdownScreen();
      } else {
        if (data.role === "admin") renderAdmin(data);
        else renderPlayer(data);
        if (data.question?.image) setBackground(data.question.image);
      }
    }
  }finally{
    inFlight = false;
  }
}

async function submitAnswer(e){
  const idx = parseInt(e.target.dataset.idx);
  if (isNaN(idx)) return;
  document.querySelectorAll(".option").forEach(b=>b.setAttribute("disabled","disabled"));
  try{
    const r = await postJSON("/api/submit", { chat_id, user: { id: user_id }, given: idx });
    if (r.ok) getState({soft:false});
    else document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
  }catch(err){
    document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
  }
}

// ---------- Точка входа ----------
if (Number.isNaN(chat_id) || Number.isNaN(user_id)) {
  app.innerHTML = `
    <div class="text-center">
      <p class="text-xl mb-2">Неверные параметры запуска.</p>
      <p class="text-sm text-gray-300">Откройте квиз через кнопку в личных сообщениях бота.</p>
    </div>
  `;
} else {
  resetBackgroundToDefault();
  renderLoading();
  getState({soft:false});
}
