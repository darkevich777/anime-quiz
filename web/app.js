const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = parseInt(params.get("chat_id"));
const user_id = parseInt(params.get("user_id"));

const app = document.getElementById("content");

let lastState = null;
let pendingAction = false;
let chosenTimer = 30; // дефолт до конфигурации админом

async function apiGetState() {
  const res = await fetch(`/api/get_state?chat_id=${chat_id}&user_id=${user_id}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  return res.json();
}

function fmtSec(s) {
  s = Math.max(0, Math.floor(s));
  const m = Math.floor(s/60);
  const r = s%60;
  if (m>0) return `${m}:${String(r).padStart(2,"0")}`;
  return `${r}с`;
}

function nowSec() { return Date.now()/1000; }

function renderLoading(msg="Загрузка...") {
  app.innerHTML = `<p class="text-lg">${msg}</p>`;
}

function progressBar(remain, total) {
  const pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/total)));
  return `
    <div class="w-full bg-purple-900/50 rounded-full h-3">
      <div class="h-3 rounded-full bg-purple-400 transition-all" style="width:${pct}%"></div>
    </div>
    <div class="text-xs text-gray-300 mt-1">Осталось: ${fmtSec(remain)}</div>
  `;
}

function buttonPrimary(id, label, disabled=false) {
  return `<button id="${id}" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}

function buttonGhost(id, label, disabled=false) {
  return `<button id="${id}" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" ${disabled?'disabled':''}>${label}</button>`;
}

function optionButton(text, idx, disabled=false, highlight=false, correct=false) {
  const base = "option py-3 px-4 rounded-lg transition text-left";
  let bg = "bg-purple-700 hover:bg-purple-600";
  if (highlight) bg = "bg-red-700";
  if (correct) bg = "bg-green-700";
  if (disabled) bg += " opacity-70 cursor-not-allowed";
  return `<button class="${base} ${bg}" data-idx="${idx}" ${disabled?'disabled':''}>${text}</button>`;
}

function isAnswered(state) {
  const me = state.players?.[String(user_id)];
  return !!me?.answered;
}

function renderAdmin(state) {
  const rnd = state.round;
  const q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  let controls = `
    <div class="p-3 bg-purple-900 rounded-lg space-y-2">
      <div class="text-sm text-gray-300">Таймер вопроса (сек):</div>
      <div class="grid grid-cols-4 gap-2">
        ${[15,30,45,60].map(s => `
          <button class="timer btn py-2 rounded-lg ${state.timer_seconds===s?'bg-purple-600':'bg-purple-800 hover:bg-purple-700'}" data-s="${s}">${s}</button>
        `).join("")}
      </div>
      ${buttonPrimary("saveTimer","💾 Сохранить таймер")}
      <div class="grid grid-cols-3 gap-2 pt-2">
        ${buttonPrimary("startRound","▶ Начать квиз / вопрос", pendingAction)}
        ${buttonGhost("nextRound","⏭ Следующий вопрос", pendingAction || !state.round || !state.round.finished)}
        ${buttonGhost("endQuiz","🛑 Завершить квиз", pendingAction)}
      </div>
      <div class="text-xs text-gray-400">Админ тоже может отвечать на вопросы.</div>
    </div>
  `;

  let body = "";
  if (!q) {
    body = `
      <div class="text-center">
        <p class="text-xl mb-2">⏳ Вопрос ещё не начат.</p>
        <p class="text-sm text-gray-300">Игроков: ${playersCount}</p>
      </div>
    `;
  } else {
    // таймер
    const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
    const total = (state.timer_seconds || 1);
    // список опций
    const optsHtml = q.options.map((opt, i) => {
      let highlight = false, correct = false;
      if (rnd?.finished) {
        correct = (i === q.answer);
      }
      return optionButton(opt, i, isAnswered(state), highlight, correct);
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
    b.onclick = () => { chosenTimer = parseInt(b.dataset.s); document.querySelectorAll(".timer").forEach(x=>x.classList.remove("bg-purple-600")); b.classList.add("bg-purple-600"); };
  });

  const saveTimerBtn = document.getElementById("saveTimer");
  if (saveTimerBtn) saveTimerBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/config", {chat_id, user_id, timer_seconds: chosenTimer});
    pendingAction = false;
    if (r.ok) getState();
  };

  const startBtn = document.getElementById("startRound");
  if (startBtn) startBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/start", {chat_id, user_id});
    pendingAction = false;
    if (r.ok) getState();
  };

  const nextBtn = document.getElementById("nextRound");
  if (nextBtn) nextBtn.onclick = async ()=>{
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/next", {chat_id, user_id});
    pendingAction = false;
    if (r.ok) getState();
  };

  const endBtn = document.getElementById("endQuiz");
  if (endBtn) endBtn.onclick = async ()=>{
    if (!confirm("Завершить квиз и показать результаты?")) return;
    pendingAction = true; renderAdmin(state);
    const r = await postJSON("/api/admin/end", {chat_id, user_id});
    pendingAction = false;
    if (r.ok) {
      renderFinalBoard(r.leaderboard || []);
    } else {
      getState();
    }
  };

  document.querySelectorAll(".option").forEach(b=>{
    b.onclick = (e)=> submitAnswer(e);
  });
}

function renderPlayer(state) {
  const rnd = state.round;
  const q = state.question;
  const playersCount = Object.keys(state.players||{}).length;

  if (!q) {
    app.innerHTML = `
      <div class="text-center">
        <p class="text-xl mb-2">⏳ Ждём начала вопроса...</p>
        <div class="text-sm text-gray-300">Игроков: ${playersCount}</div>
        <button onclick="getState()" class="mt-4 py-2 px-4 bg-blue-600 rounded-lg">🔄 Обновить</button>
      </div>
    `;
    return;
  }

  const remain = Math.max(0, (rnd?.deadline || 0) - nowSec());
  const total = (state.timer_seconds || 1);

  const optsHtml = q.options.map((opt, i) => {
    let highlight = false, correct = false;
    if (rnd?.finished) {
      correct = (i === q.answer);
    }
    return optionButton(opt, i, isAnswered(state), highlight, correct);
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
}

function renderFinalBoard(board){
  // board: [{user_id, name, score, total_time}]
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
      <div class="text-sm text-gray-300">${it.total_time.toFixed(2)} сек</div>
    </div>
  `).join("");

  app.innerHTML = `
    <h2 class="text-xl mb-4">🏁 Итоги квиза</h2>
    <div class="space-y-2">${rows}</div>
    <div class="mt-4 text-sm text-gray-300">При равенстве очков победил(и) тот(те), кто затратил меньше суммарного времени.</div>
  `;
}

async function getState() {
  try {
    const data = await apiGetState();
    if (!data.ok) {
      app.innerHTML = `<p>Ошибка загрузки игры 😢</p>`;
      return;
    }
    lastState = data;

    if (data.round && !data.round.finished) {
      // автообновление таймера — чтобы плавно двигался прогресс
      // (отрисуем заново через 1с извне)
    }

    if (data.role === "admin") {
      renderAdmin(data);
    } else {
      renderPlayer(data);
    }
  } catch (e) {
    console.error(e);
    app.innerHTML = `<p>Ошибка соединения 😢</p>`;
  }
}

async function submitAnswer(e){
  const idx = parseInt(e.target.dataset.idx);
  if (isNaN(idx)) return;
  // мгновенно заблокируем кнопки
  document.querySelectorAll(".option").forEach(b=>b.setAttribute("disabled","disabled"));
  try{
    const r = await postJSON("/api/submit", {
      chat_id,
      user: { id: user_id },
      given: idx
    });
    if (r.ok){
      // Обновим состояние
      getState();
    } else {
      // разблокируем (на случай ошибки)
      document.querySelectorAll(".option").forEach(b=>b.removeAttribute("disabled"));
    }
  }catch(err){
    console.error(err);
  }
}

// Автообновление
setInterval(getState, 1000);
getState();
