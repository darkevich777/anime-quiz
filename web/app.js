const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = params.get("chat_id");
const user_id = params.get("user_id");

const app = document.getElementById("content");

async function getState() {
  const res = await fetch(`/api/get_state?chat_id=${chat_id}&user_id=${user_id}`);
  const data = await res.json();
  if (!data.ok) return app.innerHTML = `<p>Ошибка загрузки игры 😢</p>`;
  if (data.role === "admin") renderAdmin(data);
  else renderPlayer(data);
}

function renderAdmin(data) {
  const players = Object.values(data.players).map(p => `<li>${p.name}</li>`).join("");
  app.innerHTML = `
    <h2 class="text-xl mb-4">👑 Панель администратора</h2>
    <ul class="mb-4 text-left">${players}</ul>
    <button id="startBtn" class="w-full py-3 bg-purple-600 rounded-lg">▶ ${data.question ? 'Следующий вопрос' : 'Начать игру'}</button>
  `;
  document.getElementById("startBtn").onclick = startRound;
}

async function startRound() {
  await fetch("/api/admin/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, user_id })
  });
  getState();
}

function renderPlayer(data) {
  if (!data.question) {
    app.innerHTML = `<p>⏳ Ждём начала квиза...</p>`;
    return;
  }
  const q = data.question;
  app.innerHTML = `
    <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
    <div class="grid grid-cols-2 gap-3">
      ${q.options.map((opt, i) => `
        <button class="option py-2 px-3 bg-purple-700 rounded-lg" data-idx="${i}">
          ${opt}
        </button>`).join("")}
    </div>
  `;
  document.querySelectorAll(".option").forEach(b => b.onclick = submitAnswer);
}

async function submitAnswer(e) {
  const idx = e.target.dataset.idx;
  const res = await fetch("/api/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, user: { id: user_id }, given: parseInt(idx) })
  });
  if (res.ok) {
    app.innerHTML = `<p class="text-green-400 text-xl">✅ Ответ принят!</p>`;
  } else {
    app.innerHTML = `<p class="text-red-400 text-xl">Ошибка отправки 😔</p>`;
  }
}

getState();
