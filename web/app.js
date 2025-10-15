const tg = window.Telegram.WebApp;
tg.expand();

const params = new URLSearchParams(window.location.search);
const chat_id = params.get("chat_id");
const user_id = params.get("user_id");

const app = document.getElementById("content");

console.log("🔍 Параметры URL:", { chat_id, user_id });

async function getState() {
  try {
    console.log("🔄 Запрашиваем состояние...");
    const res = await fetch(`/api/get_state?chat_id=${chat_id}&user_id=${user_id}`);
    const data = await res.json();
    console.log("📦 Получены данные:", data);
    
    if (!data.ok) {
      app.innerHTML = `<p>Ошибка загрузки игры 😢</p>`;
      return;
    }
    
    console.log(`🎭 Роль пользователя: ${data.role}`);
    if (data.role === "admin") {
      renderAdmin(data);
    } else {
      renderPlayer(data);
    }
  } catch (error) {
    console.error("❌ Ошибка getState:", error);
    app.innerHTML = `<p>Ошибка соединения 😢</p>`;
  }
}

function renderAdmin(data) {
  console.log("👑 Рендерим админ-панель");
  const players = Object.values(data.players).map(p => 
    `<li class="py-1">${p.name} ${p.answered ? '✅' : '⏳'}</li>`
  ).join("");
  
  app.innerHTML = `
    <h2 class="text-xl mb-4">👑 Панель администратора</h2>
    <div class="mb-4 p-3 bg-purple-800 rounded-lg">
      <h3 class="font-bold mb-2">Участники:</h3>
      <ul class="text-left">${players}</ul>
    </div>
    <button id="startBtn" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition">
      ▶ ${data.question ? 'Следующий вопрос' : 'Начать игру'}
    </button>
    ${data.question ? `
      <div class="mt-4 p-3 bg-green-900 rounded-lg">
        <p class="font-bold">Текущий вопрос:</p>
        <p>${data.question.question}</p>
      </div>
    ` : ''}
  `;
  document.getElementById("startBtn").onclick = startRound;
}

function renderPlayer(data) {
  console.log("🎮 Рендерим интерфейс игрока", data);
  
  if (!data.question) {
    app.innerHTML = `
      <div class="text-center">
        <p class="text-xl mb-4">⏳ Ждём начала квиза...</p>
        <button onclick="getState()" class="py-2 px-4 bg-blue-600 rounded-lg hover:bg-blue-700 transition">
          🔄 Обновить
        </button>
        <div class="mt-4 text-sm text-gray-300">
          <p>Игроков онлайн: ${Object.keys(data.players || {}).length}</p>
        </div>
      </div>
    `;
    return;
  }
  
  const q = data.question;
  console.log("❓ Вопрос для игрока:", q);
  
  app.innerHTML = `
    <h2 class="text-lg mb-3 font-semibold">${q.question}</h2>
    <div class="grid grid-cols-1 gap-3 mb-4">
      ${q.options.map((opt, i) => `
        <button class="option py-3 px-4 bg-purple-700 rounded-lg hover:bg-purple-600 transition text-left" data-idx="${i}">
          ${opt}
        </button>`).join("")}
    </div>
    <div class="text-sm text-gray-300">
      <p>Ответили: ${Object.values(data.players || {}).filter(p => p.answered).length}/${Object.values(data.players || {}).length}</p>
    </div>
  `;
  
  document.querySelectorAll(".option").forEach(b => {
    b.onclick = (e) => {
      e.target.classList.add('bg-green-600');
      submitAnswer(e);
    };
  });
}

async function startRound() {
  try {
    console.log("🎯 Админ запускает раунд");
    const btn = document.getElementById("startBtn");
    btn.disabled = true;
    btn.textContent = "Запускаем...";
    
    const response = await fetch("/api/admin/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: parseInt(chat_id), user_id: parseInt(user_id) })
    });
    
    const result = await response.json();
    console.log("📨 Ответ от сервера:", result);
    
    if (result.ok) {
      setTimeout(getState, 1000);
    }
  } catch (error) {
    console.error("❌ Ошибка startRound:", error);
  }
}

async function submitAnswer(e) {
  const idx = parseInt(e.target.dataset.idx);
  console.log(`📝 Игрок отвечает: вариант ${idx}`);
  
  try {
    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        chat_id: parseInt(chat_id), 
        user: { id: parseInt(user_id) }, 
        given: idx 
      })
    });
    
    const result = await res.json();
    console.log("📨 Ответ на submit:", result);
    
    if (res.ok) {
      app.innerHTML = `
        <div class="text-center">
          <p class="text-green-400 text-xl mb-4">✅ Ответ принят!</p>
          <p>Ждём других участников...</p>
          <button onclick="getState()" class="mt-4 py-2 px-4 bg-blue-600 rounded-lg">
            🔄 Обновить статус
          </button>
        </div>
      `;
    } else {
      app.innerHTML = `<p class="text-red-400 text-xl">Ошибка отправки 😔</p>`;
    }
  } catch (error) {
    console.error("❌ Ошибка submitAnswer:", error);
    app.innerHTML = `<p class="text-red-400 text-xl">Ошибка соединения 😔</p>`;
  }
}

// Автообновление каждую секунду
setInterval(getState, 1000);
getState();
