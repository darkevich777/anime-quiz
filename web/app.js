// ===== Mini App — синхронный старт с кворумом 80%, стабильный отсчёт =====

// Без optional chaining, максимально совместимо
var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : {};
try { if (tg.expand) tg.expand(); if (tg.ready) tg.ready(); } catch (e) {}

var params = new URLSearchParams(window.location.search);
var chat_id = parseInt(params.get("chat_id"), 10);
var user_id = parseInt(params.get("user_id"), 10);

var app = document.getElementById("content");

// === Константы ===
var POLL_INTERVAL_MS = 3000;
var DEADLINE_SLOP_MS = 300;
var LOCAL_TIMER_MS = 250;
var PRELOAD_WAIT_CAP_MS = 1200;
var OPTIONS_MIN_HEIGHT_PX = 260;

var lastState = null;
var lastRev = null;
var inFlight = false;
var lastAbort = null;
var pollTimer = null;
var deadlineTimer = null;
var localTimer = null;
var rematchTimer = null;

var chosenTimer = 30;
var chosenRounds = 10;
var currentBg = null;

// --- состояние отсчёта/предзагрузки ---
var countdownActive = false;
var countdownEndTs = 0;
var countdownRaf = null;
var countdownHardTimeout = null;
var nextQImageUrl = null;
var nextQImageReady = false;
var countingStartedAt = null;
var startOverlayTimer = null; // объявлено выше, чтобы не словить TDZ

// ---------- Утилиты ----------
function nowSec(){ return Date.now()/1000; }
function fmtSec(s){
  s = Math.max(0, Math.floor(s));
  var m = Math.floor(s/60), r = s%60;
  return m>0 ? (m + ":" + String(r).padStart(2,"0")) : (r + "с");
}
function renderLoading(msg){ if (msg === void 0) msg="Загрузка..."; app.innerHTML = '<p class="text-lg">'+msg+'</p>'; }
function scrollTop(){ try{ window.scrollTo({top:0, behavior:"instant"}); }catch(e){} }

// Стартовый фон
function resetBackgroundToDefault(){
  currentBg = null;
  document.documentElement.style.setProperty('background-image', 'none', 'important');
  document.body.style.setProperty('background-image', 'none', 'important');
  document.documentElement.style.setProperty('background', '#0b0220', 'important');
  document.body.style.setProperty('background', '#0b0220', 'important');
}

// Надёжная смена фона (без прокси)
function setBackground(url){
  if (!url || url === currentBg) return;
  var img = new Image();
  img.onload = function () {
    currentBg = url;
    document.documentElement.style.setProperty('background-image', 'url("'+url+'")', 'important');
    document.documentElement.style.setProperty('background-repeat', 'no-repeat', 'important');
    document.documentElement.style.setProperty('background-position', 'center', 'important');
    document.documentElement.style.setProperty('background-size', 'cover', 'important');
    document.documentElement.style.setProperty('background-attachment', 'fixed', 'important');
    document.body.style.setProperty('background-image', 'url("'+url+'")', 'important');
    document.body.style.setProperty('background-repeat', 'no-repeat', 'important');
    document.body.style.setProperty('background-position', 'center', 'important');
    document.body.style.setProperty('background-size', 'cover', 'important');
    document.body.style.setProperty('background-attachment', 'fixed', 'important');
  };
  img.src = url;
}
function preloadImage(url){
  return new Promise(function(resolve){
    if (!url){ resolve(true); return; }
    var img = new Image();
    img.onload = function(){ resolve(true); };
    img.onerror = function(){ resolve(false); };
    img.src = url;
  });
}

// ---------- Таймеры ----------
function startPolling(i){ if (i === void 0) i=POLL_INTERVAL_MS; if (!pollTimer) pollTimer = setInterval(function(){ getState({soft:true}); }, i); }
function stopPolling(){ if (pollTimer){ clearInterval(pollTimer); pollTimer=null; } }

function setDeadlineTimer(deadline){
  if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }
  var delay = Math.max(0, (deadline - nowSec())*1000 + DEADLINE_SLOP_MS);
  deadlineTimer = setTimeout(function(){ getState({soft:true}); }, delay);
}

function startLocalTimer(deadline, total){
  stopLocalTimer();
  localTimer = setInterval(function(){
    var remain = Math.max(0, deadline - nowSec());
    var bar = document.getElementById("timerBar");
    var rem = document.getElementById("timerRemain");
    if (bar){
      var pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
      bar.style.width = pct + "%";
    }
    if (rem) rem.textContent = "Осталось: " + fmtSec(remain);
    if (remain <= 0) stopLocalTimer();
  }, LOCAL_TIMER_MS);
}
function stopLocalTimer(){ if (localTimer){ clearInterval(localTimer); localTimer=null; } }

// ---------- API ----------
function apiGetState(signal){
  return fetch("/api/get_state?chat_id="+chat_id+"&user_id="+user_id, { signal: signal }).then(function(res){
    if (!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  });
}
function postJSON(url, body){
  return fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  }).then(function(res){
    if (!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  });
}
function apiRematchState(){
  return fetch("/api/rematch/state?chat_id="+chat_id+"&user_id="+user_id).then(function(res){
    if (!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  });
}
function apiRoundReady(){
  return fetch("/api/round/ready", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ chat_id: chat_id, user_id: user_id })
  }).then(function(res){
    if (!res.ok) throw new Error("HTTP "+res.status);
    return res.json();
  });
}

// ---------- Виджеты ----------
function progressBar(remain, total){
  var pct = Math.max(0, Math.min(100, Math.round(100*(total-remain)/Math.max(1,total))));
  return ''+
    '<div class="w-full bg-purple-900/40 rounded-full h-3">'+
      '<div id="timerBar" class="h-3 rounded-full bg-purple-400 transition-all" style="width:'+pct+'%"></div>'+
    '</div>'+
    '<div id="timerRemain" class="text-xs text-gray-100 mt-1">Осталось: '+fmtSec(remain)+'</div>';
}
function buttonPrimary(id, label, disabled){
  if (disabled === void 0) disabled=false;
  return '<button id="'+id+'" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" '+(disabled?'disabled':'')+'>'+label+'</button>';
}
function buttonGhost(id, label, disabled){
  if (disabled === void 0) disabled=false;
  return '<button id="'+id+'" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition disabled:opacity-50 disabled:cursor-not-allowed" '+(disabled?'disabled':'')+'>'+label+'</button>';
}
function optionButton(text, idx, disabled, correct){
  if (disabled === void 0) disabled=false;
  if (correct === void 0) correct=false;
  var base="option py-3 px-4 rounded-lg transition text-left";
  var bg="bg-purple-700 hover:bg-purple-600";
  if (correct) bg = "bg-green-700";
  if (disabled) bg += " opacity-70 cursor-not-allowed";
  return '<button class="'+base+' '+bg+'" data-idx="'+idx+'" '+(disabled?'disabled':'')+'>'+text+'</button>';
}
function isAnswered(state){
  var me = state.players && state.players[String(user_id)];
  return !!(me && me.answered);
}

// ---------- Экран отсчёта ----------
function showCountdownScreen(){
  app.innerHTML = ''+
    '<div class="flex items-center justify-center" style="min-height:60vh">'+
      '<div class="text-center">'+
        '<div class="text-xl mb-2">Готовимся к следующему вопросу…</div>'+
        '<div id="cdVal" class="text-6xl font-semibold">3</div>'+
      '</div>'+
    '</div>';
}
function clearCountdown(){
  countdownActive = false;
  countingStartedAt = null;
  if (countdownRaf) cancelAnimationFrame(countdownRaf);
  countdownRaf = null;
  if (countdownHardTimeout) clearTimeout(countdownHardTimeout);
  countdownHardTimeout = null;
  if (startOverlayTimer){ clearTimeout(startOverlayTimer); startOverlayTimer = null; }
  var ov = document.getElementById("softStartOverlay");
  if (ov) ov.remove();
}

function startCountdownForQuestion(startedAt, imageUrl, countdownSec){
  if (countdownActive && countingStartedAt === startedAt) return;

  var serverEnd = startedAt + countdownSec;
  var timeLeft = serverEnd - nowSec();

  if (timeLeft <= 0.15){
    if (imageUrl) preloadImage(imageUrl).then(function(){ setBackground(imageUrl); });
    clearCountdown();
    apiRoundReady().then(function(){ return getState({soft:false}); }).catch(function(){});
    return;
  }

  countdownActive = true;
  countingStartedAt = startedAt;
  countdownEndTs = serverEnd;
  nextQImageUrl = imageUrl || null;
  nextQImageReady = false;

  preloadImage(nextQImageUrl).then(function(ok){ nextQImageReady = ok || !imageUrl; });

  resetBackgroundToDefault();
  showCountdownScreen();

  var tick = function(){
    if (!countdownActive || countingStartedAt !== startedAt) return;
    var left = Math.ceil(countdownEndTs - nowSec());
    var el = document.getElementById("cdVal");
    if (el) el.textContent = String(Math.max(0, left));
    if (left <= 0){
      finishCountdownAndSignalReady();
    } else {
      countdownRaf = requestAnimationFrame(tick);
    }
  };
  countdownRaf = requestAnimationFrame(tick);

  if (countdownHardTimeout) clearTimeout(countdownHardTimeout);
  countdownHardTimeout = setTimeout(function(){
    if (countdownActive && countingStartedAt === startedAt) finishCountdownAndSignalReady();
  }, countdownSec*1000 + PRELOAD_WAIT_CAP_MS + 400);
}

function finishCountdownAndSignalReady(){
  var waitUntil = Date.now() + PRELOAD_WAIT_CAP_MS;
  var waitLoop = function(){
    if (!countdownActive) return;
    if (nextQImageReady || Date.now() > waitUntil){
      if (nextQImageUrl) setBackground(nextQImageUrl);
      apiRoundReady().then(function(){ return getState({soft:false}); }).catch(function(){});
      clearCountdown();
    } else {
      setTimeout(waitLoop, 60);
    }
  };
  waitLoop();
}

function maybeDismissCountdownByState(data){
  if (!countdownActive) return;
  var qAt = data.round && data.round.question_at;
  if (!qAt) return;
  var now = nowSec();
  if (now >= qAt){
    if (nextQImageUrl){
      if (nextQImageReady) setBackground(nextQImageUrl);
      else setTimeout(function(){ setBackground(nextQImageUrl); }, 0);
    }
    clearCountdown();
  }
}

// --- Мини-оверлей «мягкий старт» ---
function showSoftStartOverlay(ms){
  if (ms === void 0) ms = 1000;
  if (document.getElementById("softStartOverlay")) return;
  var ov = document.createElement("div");
  ov.id = "softStartOverlay";
  ov.style.position = "fixed";
  ov.style.inset = "0";
  ov.style.zIndex = "9999";
  ov.style.display = "flex";
  ov.style.alignItems = "center";
  ov.style.justifyContent = "center";
  ov.style.pointerEvents = "none";
  ov.style.background = "rgba(0,0,0,0.18)";
  ov.innerHTML = '<div style="font-size:64px;font-weight:700;opacity:.96;transform:translateY(-6px)"><span id="softStartNum">1</span></div>';
  document.body.appendChild(ov);
  var num = document.getElementById("softStartNum");
  var left = Math.max(200, Math.min(1000, ms));
  var tick = function(){
    left -= 120;
    if (left < 420 && num && num.textContent !== "0") num.textContent = "0";
    if (left <= 0){
      ov.style.transition = "opacity .2s ease";
      ov.style.opacity = "0";
      startOverlayTimer = setTimeout(function(){ ov.remove(); startOverlayTimer = null; }, 220);
    } else {
      startOverlayTimer = setTimeout(tick, 120);
    }
  };
  startOverlayTimer = setTimeout(tick, 120);
}

// ---------- Рендеры ----------
function renderAdmin(state){
  var rnd = state.round, q = state.question;
  var playersCount = Object.keys(state.players||{}).length;
  var firstScreen = !state.round;

  var settingsBlock = firstScreen ? (
    '<div class="p-3 bg-purple-900/40 rounded-lg space-y-2 border border-white/10">'+
      '<div class="text-sm text-gray-100">Таймер вопроса (сек):</div>'+
      '<div class="grid grid-cols-4 gap-2">'+
        [15,30,45,60].map(function(s){
          var selected = (state.timer_seconds != null ? state.timer_seconds : chosenTimer) === s;
          return '<button class="timer btn py-2 rounded-lg '+(selected ? 'bg-purple-600':'')+'" data-s="'+s+'">'+s+'</button>';
        }).join("")+
      '</div>'+
      '<div class="text-sm text-gray-100 mt-3">Количество раундов:</div>'+
      '<div class="grid grid-cols-4 gap-2">'+
        [10,15,20,30].map(function(n){
          return '<button class="rounds btn py-2 rounded-lg '+(((state.rounds_total||10)===n)?'bg-purple-600':'')+'" data-n="'+n+'">'+n+'</button>';
        }).join("")+
      '</div>'+
      buttonPrimary("saveSettings","💾 Сохранить настройки")+
    '</div>'
  ) : "";

  var controls =
    '<div class="p-3 bg-purple-900/40 rounded-lg space-y-2 mt-3 border border-white/10">'+
      '<div class="grid '+(firstScreen ? 'grid-cols-1' : 'grid-cols-2')+' gap-2">'+
        (firstScreen ? buttonPrimary("startRound","▶ Начать квиз") : "")+
        buttonGhost("nextRound","⏭ Следующий вопрос", !state.round || !state.round.finished)+
        buttonGhost("forceStart","⚡ Форс-старт", !state.round || !!(state.round && state.round.question_at) || (state.round && state.round.finished))+
        buttonGhost("endQuiz","🛑 Завершить квиз")+
      '</div>'+
      '<div class="text-xs text-gray-100">Админ тоже может отвечать.</div>'+
    '</div>';

  if (countdownActive){
    app.innerHTML = '<h2 class="text-xl mb-4">👑 Панель администратора</h2>'+settingsBlock+controls;
    showCountdownScreen();
    return;
  }

  var body = "";
  if (!q){
    body =
      '<div class="p-3 bg-purple-800/30 rounded-lg border border-white/10 text-center">'+
        '<p class="text-xl mb-2">🎮 Квиз ещё не начался!</p>'+
        '<p class="text-sm text-gray-100">Игроков: '+playersCount+'</p>'+
      '</div>';
  } else {
    var remain = Math.max(0, (rnd && rnd.deadline || 0) - nowSec());
    var total = (state.timer_seconds||1);
    var finished = !!(state.round && state.round.finished && typeof q.answer === "number");
    var optsHtml = q.options.map(function(opt,i){
      var correct = finished && (i===q.answer);
      var disabled = isAnswered(state) || finished;
      return optionButton(opt, i, disabled, correct);
    }).join("");
    body =
      '<div class="mt-4 p-3 bg-purple-800/30 rounded-lg border border-white/10">'+
        '<h2 class="text-lg mb-3 font-semibold">'+q.question+'</h2>'+
        '<div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:'+OPTIONS_MIN_HEIGHT_PX+'px">'+optsHtml+'</div>'+
        ((rnd && rnd.deadline) ? ('<div class="mt-2">'+progressBar(remain, total)+'</div>') : '')+
        '<div class="text-sm text-gray-100 mt-2">Ответили: '+Object.values(state.players||{}).filter(function(p){return p.answered;}).length+'/'+playersCount+'</div>'+
      '</div>';
    if (q.image) setBackground(q.image);
  }

  app.innerHTML =
    '<h2 class="text-xl mb-4">👑 Панель администратора</h2>'+
    settingsBlock+
    controls+
    body;
  scrollTop();

  Array.prototype.forEach.call(document.querySelectorAll(".timer"), function(b){
    b.onclick = function(){
      chosenTimer = parseInt(b.dataset.s, 10);
      Array.prototype.forEach.call(document.querySelectorAll(".timer"), function(x){ x.classList.remove("bg-purple-600"); });
      b.classList.add("bg-purple-600");
    };
  });
  Array.prototype.forEach.call(document.querySelectorAll(".rounds"), function(b){
    b.onclick = function(){
      chosenRounds = parseInt(b.dataset.n, 10);
      Array.prototype.forEach.call(document.querySelectorAll(".rounds"), function(x){ x.classList.remove("bg-purple-600"); });
      b.classList.add("bg-purple-600");
    };
  });

  var saveSettingsBtn = document.getElementById("saveSettings");
  if (saveSettingsBtn) saveSettingsBtn.onclick = function(){
    saveSettingsBtn.disabled = true;
    postJSON("/api/admin/config", { chat_id: chat_id, user_id: user_id, timer_seconds: chosenTimer, rounds_total: chosenRounds })
      .then(function(r){ if (r.ok) getState({soft:false}); })
      .catch(function(){ renderLoading("Не удаётся сохранить настройки. Проверь соединение."); })
      .finally(function(){ saveSettingsBtn.disabled = false; });
  };

  var startBtn = document.getElementById("startRound");
  if (startBtn) startBtn.onclick = function(){
    startBtn.disabled = true;
    postJSON("/api/admin/config", { chat_id: chat_id, user_id: user_id, timer_seconds: chosenTimer, rounds_total: chosenRounds })
      .then(function(c){
        if (!c.ok) { startBtn.disabled=false; return; }
        return postJSON("/api/admin/start", { chat_id: chat_id, user_id: user_id, timer_seconds: chosenTimer });
      })
      .then(function(r){ if (r && r.ok) getState({soft:false}); })
      .catch(function(){ renderLoading("Старт не удался. Сервер молчит."); })
      .finally(function(){ startBtn.disabled = false; });
  };

  var nextBtn = document.getElementById("nextRound");
  if (nextBtn) nextBtn.onclick = function(){
    if (nextBtn.disabled) return;
    nextBtn.disabled = true;
    postJSON("/api/admin/next", {chat_id: chat_id, user_id: user_id})
      .then(function(r){ if (r.ok) getState({soft:false}); })
      .catch(function(){ renderLoading("Не получилось перейти к следующему вопросу."); })
      .finally(function(){ nextBtn.disabled = false; });
  };

  var fsBtn = document.getElementById("forceStart");
  if (fsBtn) fsBtn.onclick = function(){
    if (fsBtn.disabled) return;
    fsBtn.disabled = true;
    postJSON("/api/admin/force_start", {chat_id: chat_id, user_id: user_id})
      .then(function(r){ if (r.ok) getState({soft:false}); })
      .catch(function(){ renderLoading("Форс-старт не сработал. Сервер в отпуске?"); })
      .finally(function(){ fsBtn.disabled = false; });
  };

  var endBtn = document.getElementById("endQuiz");
  if (endBtn) endBtn.onclick = function(){
    endBtn.disabled = true;
    postJSON("/api/admin/end", {chat_id: chat_id, user_id: user_id})
      .then(function(r){
        if (r.ok){
          stopPolling(); stopLocalTimer();
          renderFinalBoard(r.leaderboard || []);
          startRematchWatch();
        }
      })
      .catch(function(){ renderLoading("Завершить квиз не удалось."); })
      .finally(function(){ endBtn.disabled = false; });
  };

  Array.prototype.forEach.call(document.querySelectorAll(".option"), function(b){
    b.onclick = function(e){ submitAnswer(e); };
  });

  if (state.round && state.round.deadline && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
  } else {
    stopLocalTimer();
  }
}

function renderPlayer(state){
  var rnd = state.round, q = state.question;
  var playersCount = Object.keys(state.players||{}).length;

  if (countdownActive){
    showCountdownScreen();
    return;
  }

  if (!q){
    app.innerHTML =
      '<div class="p-3 bg-purple-800/30 rounded-lg border border-white/10 text-center">'+
        '<p class="text-xl mb-2">🎮 Квиз ещё не начался!</p>'+
        '<p class="text-sm text-gray-100">Игроков: '+playersCount+'</p>'+
      '</div>';
    stopLocalTimer(); scrollTop();
    return;
  }

  var remain = Math.max(0, (rnd && rnd.deadline || 0) - nowSec());
  var total = (state.timer_seconds||1);
  var finished = !!(state.round && state.round.finished && typeof q.answer === "number");

  var optsHtml = q.options.map(function(opt,i){
    var correct = finished && (i===q.answer);
    var disabled = isAnswered(state) || finished;
    return optionButton(opt, i, disabled, correct);
  }).join("");

  app.innerHTML =
    '<div class="mt-4 p-3 bg-purple-800/30 rounded-lg border border-white/10">'+
      '<h2 class="text-lg mb-3 font-semibold">'+q.question+'</h2>'+
      '<div id="optionsBox" class="grid grid-cols-1 gap-3 mb-4" style="min-height:'+OPTIONS_MIN_HEIGHT_PX+'px">'+optsHtml+'</div>'+
      ((rnd && rnd.deadline) ? ('<div class="mt-2">'+progressBar(remain, total)+'</div>') : '')+
      '<div class="text-sm text-gray-100 mt-2">Ответили: '+Object.values(state.players||{}).filter(function(p){return p.answered;}).length+'/'+playersCount+'</div>'+
    '</div>';
  scrollTop();

  Array.prototype.forEach.call(document.querySelectorAll(".option"), function(b){
    b.onclick = function(e){ submitAnswer(e); };
  });

  if (state.round && state.round.deadline && !state.round.finished){
    startLocalTimer(state.round.deadline, state.timer_seconds || 1);
  } else {
    stopLocalTimer();
  }
}

function renderFinalBoard(board){
  resetBackgroundToDefault();
  stopLocalTimer();

  var medals=["🥇","🥈","🥉"];
  var rows = (board||[]).map(function(it,idx){
    return ''+
    '<div class="flex items-center justify-between py-2 px-3 bg-purple-900/30 rounded-lg border border-white/10">'+
      '<div>'+(medals[idx] || "🎖️")+'</div>'+
      '<div class="font-semibold">'+it.name+'</div>'+
      '<div>'+it.score+' балл(ов)</div>'+
      '<div class="text-sm text-gray-200">'+Number(it.total_time).toFixed(2)+' сек</div>'+
    '</div>';
  }).join("");

  var joinToggleBtn = '<button id="rematchToggle" class="w-full py-3 bg-purple-600 rounded-lg hover:bg-purple-700 transition">🔁 Участвовать ещё раз</button>';

  var adminPanel =
    '<div id="rematchAdmin" class="mt-4 p-3 bg-purple-900/30 rounded-lg border border-white/10 hidden">'+
      '<div class="text-sm mb-2">Подтвердили участие:</div>'+
      '<div id="rematchList" class="space-y-1 text-sm"></div>'+
      '<div class="mt-3"><button id="rematchStart" class="w-full py-3 bg-purple-800 rounded-lg hover:bg-purple-700 transition" disabled>🚀 Перезапустить квиз</button></div>'+
    '</div>';

  app.innerHTML =
    '<h2 class="text-xl mb-4">🏁 Итоги квиза</h2>'+
    '<div class="space-y-2">'+(rows || "<div>Участников не было 🤷‍♂️</div>")+'</div>'+
    '<div class="mt-6">'+joinToggleBtn+'</div>'+
    adminPanel;

  var toggleBtn = document.getElementById("rematchToggle");
  if (toggleBtn) toggleBtn.onclick = function(){
    apiRematchState()
      .then(function(s){
        var inList = s.ok && s.confirmed && s.confirmed[String(user_id)];
        if (inList){
          return postJSON("/api/rematch/leave", {chat_id: chat_id, user_id: user_id});
        } else {
          var name = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name) ? tg.initDataUnsafe.user.first_name : "Игрок";
          return postJSON("/api/rematch/join", {chat_id: chat_id, user_id: user_id, name: name});
        }
      })
      .then(function(){ updateRematchAdminUI(); })
      .catch(function(){ renderLoading("Рематч недоступен. Сервер занят важными делами."); });
  };

  updateRematchAdminUI(true);
}

function updateRematchAdminUI(forceShow){
  if (forceShow === void 0) forceShow=false;
  return apiRematchState().then(function(data){
    var box = document.getElementById("rematchAdmin");
    if (!box) return;
    if (!data.ok){ box.classList.add("hidden"); return; }

    if (forceShow || data.admin_id === user_id) box.classList.remove("hidden"); else box.classList.add("hidden");

    var list = document.getElementById("rematchList");
    var items = Object.values(data.confirmed || {});
    if (list){
      list.innerHTML = items.length ? items.map(function(n){return '<div>• '+n+'</div>';}).join("") : "<div>— пока никто</div>";
    }

    var startBtn = document.getElementById("rematchStart");
    if (startBtn){
      startBtn.disabled = !(items.length >= 1);
      startBtn.onclick = function(){
        if (startBtn.disabled) return;
        postJSON("/api/rematch/start", {chat_id: chat_id, user_id: user_id})
          .then(function(r){
            if (r.ok){
              if (rematchTimer){ clearInterval(rematchTimer); rematchTimer=null; }
              renderLoading("Запуск новой игры…");
              getState({soft:false});
            }
          })
          .catch(function(){ renderLoading("Не удалось перезапустить квиз."); });
      };
    }

    var toggle = document.getElementById("rematchToggle");
    if (toggle){
      var inList = data.confirmed && data.confirmed[String(user_id)];
      toggle.textContent = inList ? "✖️ Отменить участие" : "🔁 Участвовать ещё раз";
    }
  }).catch(function(){ /* молча */ });
}
function startRematchWatch(){
  if (rematchTimer) clearInterval(rematchTimer);
  rematchTimer = setInterval(updateRematchAdminUI, 2000);
}

// ---------- Синхронизация ----------
function getState(opts){
  if (opts === void 0) opts = {};
  if (inFlight) return;
  inFlight = true;

  try{
    if (lastAbort && lastAbort.abort) lastAbort.abort();
    lastAbort = new AbortController();

    apiGetState(lastAbort.signal).then(function(data){

      if (data.ended){
        stopPolling(); stopLocalTimer();
        apiRematchState().then(function(rs){
          if (rs.ok){
            renderFinalBoard(rs.leaderboard || []);
            startRematchWatch();
          } else {
            renderLoading("Квиз завершён.");
            resetBackgroundToDefault();
          }
        }).catch(function(){
          renderLoading("Квиз завершён.");
          resetBackgroundToDefault();
        });
        return;
      }
      if (!data.ok){ renderLoading("Игра не найдена."); return; }

      maybeDismissCountdownByState(data);

      var startedAt = data.round && data.round.started_at;
      var newQuestion = startedAt && (!lastState || !lastState.round || startedAt !== lastState.round.started_at);

      if (newQuestion){
        var imgUrl = data.question && data.question.image || null;
        var cd = data.round && data.round.countdown_sec || 3;
        startCountdownForQuestion(startedAt, imgUrl, cd);
      }

      var wasWaiting = !!(lastState && lastState.round && !lastState.round.question_at && !lastState.round.finished);
      var nowWaiting  = !!(data.round && !data.round.question_at && !data.round.finished);
      var justSwitchedToQuestion = wasWaiting && !nowWaiting && !!(data.round && data.round.question_at);

      if (data.rev !== lastRev || !opts.soft || newQuestion){
        lastRev = data.rev;
        lastState = data;

        if (data.timer_seconds) chosenTimer = data.timer_seconds;
        if (data.rounds_total) chosenRounds = data.rounds_total;

        if (data.round && data.round.deadline && !data.round.finished) startPolling(POLL_INTERVAL_MS);
        else startPolling(1000);

        if (data.round && data.round.deadline && !data.round.finished) setDeadlineTimer(data.round.deadline);
        else if (deadlineTimer){ clearTimeout(deadlineTimer); deadlineTimer=null; }

        if (!data.round || data.round.finished){
          if (data.role === "admin") renderAdmin(data);
          else renderPlayer(data);
          if (data.question && data.question.image) setBackground(data.question.image);
        } else {
          if (!data.round.question_at){
            showWaitingOthers(data);
          } else {
            if (data.role === "admin") renderAdmin(data);
            else renderPlayer(data);
            if (data.question && data.question.image) setBackground(data.question.image);
          }
        }

        if (justSwitchedToQuestion){
          var now = nowSec();
          var qAt = data.round.question_at || now;
          var latenessMs = Math.max(0, (now - qAt) * 1000);
          var dur = latenessMs < 200 ? 900 : (latenessMs < 1200 ? 600 : 450);
          showSoftStartOverlay(dur);
        }

        if (!lastState && data.round && data.round.question_at && !data.round.finished){
          var now2 = nowSec();
          var qAt2 = data.round.question_at;
          var latenessMs2 = Math.max(0, (now2 - qAt2) * 1000);
          if (latenessMs2 > 200) {
            showSoftStartOverlay(latenessMs2 > 4000 ? 350 : 550);
          }
        }
      }
    }).catch(function(e){
      console.error("getState error:", e);
      renderLoading("Не могу достучаться до сервера. Убедись, что фронт и API на одном домене.");
      startPolling(3000);
    }).finally(function(){
      inFlight = false;
    });
  } catch (e) {
    inFlight = false;
    renderLoading("Критическая ошибка клиента. Обнови приложение.");
  }
}

function showWaitingOthers(state){
  var readyDone = state.round && state.round.ready_done || 0;
  var readyTotal = state.round && state.round.ready_total || 0;
  var need = state.round && state.round.ready_required || 1;

  app.innerHTML =
    '<div class="p-3 bg-purple-800/30 rounded-lg border border-white/10 text-center">'+
      '<p class="text-xl mb-2">Ожидаем готовность игроков…</p>'+
      '<p class="text-sm text-gray-100">Готовы: '+readyDone+'/'+readyTotal+' (нужно '+need+')</p>'+
      '<div class="mt-3">'+buttonPrimary("imReady","✅ Я готов(а)")+'</div>'+
    '</div>';
  var btn = document.getElementById("imReady");
  if (btn) btn.onclick = function(){
    btn.disabled = true;
    apiRoundReady().then(function(){ return getState({soft:false}); }).catch(function(){ btn.disabled = false; });
  };
}

// ---------- Точка входа ----------
if (isNaN(chat_id) || isNaN(user_id)) {
  app.innerHTML =
    '<div class="text-center">'+
      '<p class="text-xl mb-2">Неверные параметры запуска.</p>'+
      '<p class="text-sm text-gray-300">Откройте квиз через кнопку в личных сообщениях бота.</p>'+
    '</div>';
} else {
  resetBackgroundToDefault();
  renderLoading();
  getState({soft:false});
}

function submitAnswer(e){
  var idx = parseInt(e.target.getAttribute("data-idx"), 10);
  if (isNaN(idx)) return;
  Array.prototype.forEach.call(document.querySelectorAll(".option"), function(b){ b.setAttribute("disabled","disabled"); });
  postJSON("/api/submit", { chat_id: chat_id, user: { id: user_id }, given: idx })
    .then(function(r){
      if (r.ok) getState({soft:false});
      else Array.prototype.forEach.call(document.querySelectorAll(".option"), function(b){ b.removeAttribute("disabled"); });
    })
    .catch(function(){
      Array.prototype.forEach.call(document.querySelectorAll(".option"), function(b){ b.removeAttribute("disabled"); });
    });
}
