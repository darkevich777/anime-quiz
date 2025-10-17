import os
import time
import random
import math
import requests
from urllib.parse import urlparse
from flask import Flask, request, jsonify, Response
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo

# === Конфигурация ===
TOKEN = os.getenv("BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("BOT_TOKEN не задан в переменных окружения")

# Публичная база для веба (нормализуем, чтобы всегда было ".../web/")
_public_host = os.getenv("PUBLIC_BASE") or os.getenv("RENDER_EXTERNAL_HOSTNAME")
if _public_host and not _public_host.startswith("http"):
    _public_host = f"https://{_public_host}"

WEBAPP_BASE = os.getenv("WEBAPP_BASE")
if not WEBAPP_BASE:
    if _public_host:
        WEBAPP_BASE = f"{_public_host.rstrip('/')}/web/"
    else:
        # локальная разработка — тот же хост
        WEBAPP_BASE = "/web/"
# гарантируем закрывающий слэш
WEBAPP_BASE = WEBAPP_BASE.rstrip("/") + "/"

# Вебхук — приоритет у WEBHOOK_URL, иначе строим из RENDER_EXTERNAL_HOSTNAME и роута с TOKEN
EXPLICIT_WEBHOOK_URL = os.getenv("WEBHOOK_URL")

# Константы
MIN_TIMER = 5
MAX_TIMER = 300
DEADLINE_SLOP_SEC = 0.3  # "фора" к дедлайну
COUNTDOWN_SEC = 3        # преролл перед началом вопроса
GO_SYNC_DELAY_SEC = 0.2  # небольшая задержка для синхронного старта

bot = telebot.TeleBot(TOKEN, parse_mode="Markdown")
app = Flask(__name__, static_url_path='', static_folder='web')

# === Маршруты для web ===
@app.route('/')
def index():
    return "✅ Bot is running!", 200

@app.route('/web/<path:path>')
def serve_web(path):
    return app.send_static_file(path)

@app.route('/web/')
def serve_web_index():
    return app.send_static_file('index.html')

# Быстрый пинг для диагностики
@app.route("/api/_ping")
def ping():
    return jsonify({"ok": True, "ts": time.time()})

# Вебхук (универсальный)
@app.route('/webhook/', methods=['POST', 'GET'])
def webhook_handler():
    if request.method == 'POST':
        update = telebot.types.Update.de_json(request.stream.read().decode("utf-8"))
        bot.process_new_updates([update])
        return "ok", 200
    else:
        return "Webhook endpoint", 200

# Вебхук на /{TOKEN} (на случай альтернативной конфигурации)
@app.route(f"/{TOKEN}", methods=["POST"])
def telegram_webhook():
    update = telebot.types.Update.de_json(request.stream.read().decode("utf-8"))
    bot.process_new_updates([update])
    return "ok", 200

# === Прокси изображений (решение проблемы с VPN/CDN) ===
ALLOWED_IMG_HOSTS = {"s4.anilist.co", "img.anili.st", "anilist.co"}

@app.route("/api/img")
def proxy_img():
    url = request.args.get("u", "")
    try:
        pu = urlparse(url)
        if pu.scheme not in ("http", "https"):
            return "bad scheme", 400
        host = pu.hostname or ""
        if host not in ALLOWED_IMG_HOSTS and not host.endswith(".anilist.co"):
            return "host not allowed", 400
        r = requests.get(url, stream=True, timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        ct = r.headers.get("Content-Type", "image/jpeg")
        resp = Response(r.iter_content(64 * 1024), status=r.status_code, content_type=ct)
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp
    except Exception as e:
        print(f"❌ /api/img proxy error: {e}")
        return "error", 502

# === Источник данных (AniList API) ===
ANILIST_API = "https://graphql.anilist.co"

def fetch_anime_with_details():
    query = """
    query ($page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: POPULARITY_DESC) {
          id
          title { romaji }
          startDate { year }
          genres
          studios(isMain: true) { nodes { name } }
          characters(perPage: 5, sort: ROLE) {
            nodes { name { full } }
          }
          coverImage { extraLarge large medium color }
          bannerImage
        }
      }
    }
    """
    page = random.randint(1, 100)
    resp = requests.post(ANILIST_API, json={"query": query, "variables": {"page": page, "perPage": 50}})
    resp.raise_for_status()
    data = resp.json()
    return random.choice(data["data"]["Page"]["media"])

def pick_image(anime):
    ci = anime.get("coverImage") or {}
    return ci.get("extraLarge") or ci.get("large") or anime.get("bannerImage") or None

def generate_question():
    anime = fetch_anime_with_details()
    title = anime["title"]["romaji"]
    img = pick_image(anime)
    q_type = random.choice(["genre", "year", "studio", "character"])

    if q_type == "genre" and anime.get("genres"):
        correct = random.choice(anime["genres"])
        wrongs = set()
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("genres"):
                g = random.choice(other["genres"])
                if g != correct:
                    wrongs.add(g)
        options = list(wrongs) + [correct]
        random.shuffle(options)
        return {"question": f"К какому жанру относится аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct, "image": img}

    if q_type == "year" and anime.get("startDate") and anime["startDate"].get("year"):
        correct = anime["startDate"]["year"]
        options = {correct}
        while len(options) < 4:
            fake = correct + random.randint(-10, 10)
            if fake > 1950:
                options.add(fake)
        options = list(options)
        random.shuffle(options)
        return {"question": f"В каком году вышло аниме *{title}*?",
                "options": [str(x) for x in options], "answer": options.index(correct),
                "correct_text": str(correct), "image": img}

    if q_type == "studio" and anime.get("studios") and anime["studios"].get("nodes"):
        correct = anime["studios"]["nodes"][0]["name"]
        wrongs = set()
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("studios") and other["studios"].get("nodes"):
                st = other["studios"]["nodes"][0]["name"]
                if st != correct:
                    wrongs.add(st)
        options = list(wrongs) + [correct]
        random.shuffle(options)
        return {"question": f"Какая студия выпустила аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct, "image": img}

    if q_type == "character" and anime.get("characters") and anime["characters"].get("nodes"):
        correct = anime["characters"]["nodes"][0]["name"]["full"]
        wrongs = set()
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("characters") and other["characters"].get("nodes"):
                ch = other["characters"]["nodes"][0]["name"]["full"]
                if ch != correct:
                    wrongs.add(ch)
        options = list(wrongs) + [correct]
        random.shuffle(options)
        return {"question": f"Кто главный герой в аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct, "image": img}

    return generate_question()

# === Состояние игры ===
game_states = {}
rematch_states = {}

def ensure_chat_state(chat_id):
    if chat_id not in game_states:
        game_states[chat_id] = {
            "players": {},
            "scores": {},
            "admin_id": None,
            "quiz_started": False,
            "locked": False,
            "timer_seconds": None,
            "rounds_total": 10,
            "rounds_played": 0,
            "round": None,
            "rev": 0
        }
    return game_states[chat_id]

def bump_rev(gs):
    gs["rev"] = gs.get("rev", 0) + 1

def deep_link(bot_username, chat_id):
    return f"https://t.me/{bot_username}?start=join_{chat_id}"

def send_webapp_button_to_user(user_id, chat_id):
    base = WEBAPP_BASE.rstrip('/') + '/'
    url = f"{base}?chat_id={chat_id}&user_id={user_id}"
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton(text="🎮 Открыть квиз", web_app=WebAppInfo(url=url)))
    bot.send_message(user_id, "Открываем квиз! Нажмите кнопку ниже:", reply_markup=markup)

def finalize_round_if_needed(gs, chat_id):
    rnd = gs["round"]
    if not rnd or rnd["finished"] or rnd.get("deadline") is None:
        return
    now = time.time()
    all_answered = all(p["answered"] for p in gs["players"].values())
    timeout = now >= rnd["deadline"] - DEADLINE_SLOP_SEC
    if not all_answered and not timeout:
        return

    rnd["finished"] = True
    qstart = rnd.get("question_at", rnd["started_at"])
    for uid, p in gs["players"].items():
        if not p["answered"]:
            p["last_answer_time"] = None
            p["total_time"] += max(0.0, (rnd.get("deadline") or qstart) - qstart)
    bump_rev(gs)

def compute_leaderboard(gs):
    items = []
    for uid, p in gs["players"].items():
        items.append((uid, p["name"], gs["scores"].get(uid, 0), round(p.get("total_time", 0.0), 3)))
    items.sort(key=lambda x: (-x[2], x[3], x[1].lower()))
    return items

def medals_for_position(pos):
    return ["🥇", "🥈", "🥉"][pos] if pos < 3 else "🎖️"

# === Команды бота ===
@bot.message_handler(commands=['start'])
def start_cmd(msg):
    text = (msg.text or "").strip()
    if "join_" in text:
        try:
            chat_id = int(text.split("join_")[1].strip())
        except Exception:
            bot.send_message(msg.chat.id, "Не удалось понять, из какой группы вы регистрируетесь.")
            return
        gs = ensure_chat_state(chat_id)
        if gs["locked"]:
            bot.send_message(msg.chat.id, "Квиз уже начался, новых участников добавить нельзя.")
            return
        uid = msg.from_user.id
        name = msg.from_user.first_name or "Игрок"
        if uid not in gs["players"]:
            gs["players"][uid] = {"name": name, "answered": False, "dm_ok": True, "total_time": 0.0, "last_answer_time": None}
            gs["scores"][uid] = 0
            bump_rev(gs)
            bot.send_message(msg.chat.id, f"Отлично, {name}! Вы зарегистрированы в квизе.")
            try: bot.send_message(chat_id, f"✅ {name} теперь в игре!")
            except Exception: pass
        else:
            gs["players"][uid]["dm_ok"] = True
            bump_rev(gs)
            bot.send_message(msg.chat.id, "Вы уже зарегистрированы. Удачи!")
        return

    bot.send_message(
        msg.chat.id,
        "Привет! 👋 Я готов к игре.\n"
        "Теперь вернитесь в групповой чат и снова отправьте /register — бот сможет написать вам в личку и зарегистрирует вас."
    )

@bot.message_handler(commands=["register"])
def register(msg):
    chat_id = msg.chat.id
    if msg.chat.type not in ("group", "supergroup"):
        bot.send_message(chat_id, "Команда /register — для группового чата.")
        return
    gs = ensure_chat_state(chat_id)
    if gs["locked"]:
        bot.send_message(chat_id, "Квиз уже начался. Новых участников добавить нельзя.")
        return
    uid = msg.from_user.id
    name = msg.from_user.first_name or "Игрок"
    if uid in gs["players"]:
        bot.send_message(chat_id, f"{name}, ты уже участвуешь!")
        return
    bot_username = bot.get_me().username
    try:
        bot.send_message(uid, "Привет! Вы зарегистрированы в квизе. Ожидайте начала игры.")
        dm_ok = True
    except Exception:
        dm_ok = False
    gs["players"][uid] = {"name": name, "answered": False, "dm_ok": dm_ok, "total_time": 0.0, "last_answer_time": None}
    gs["scores"][uid] = 0
    bump_rev(gs)
    if dm_ok:
        bot.send_message(chat_id, f"✅ {name} зарегистрировался(лась).")
    else:
        link_deep = deep_link(bot_username, chat_id)
        link_plain = f"https://t.me/{bot_username}"
        bot.send_message(chat_id, f"⚠️ {name}, открой ЛС с ботом: {link_deep} (или {link_plain}) и нажми Start, затем /register ещё раз.")

@bot.message_handler(commands=["status"])
def status(msg):
    chat_id = msg.chat.id
    gs = game_states.get(chat_id)
    if not gs:
        bot.send_message(chat_id, "Игра ещё не создана. Используйте /register.")
        return
    lines = ["*Участники:*"] + [f"- {p['name']}" for p in gs["players"].values()] or ["— пока никого 😅"]
    bot.send_message(chat_id, "\n".join(lines))

@bot.message_handler(commands=["quiz"])
def quiz(msg):
    chat_id = msg.chat.id
    if msg.chat.type not in ("group", "supergroup"):
        bot.send_message(chat_id, "Команда /quiz — для группового чата.")
        return
    gs = ensure_chat_state(chat_id)
    if not gs["players"]:
        bot.send_message(chat_id, "Сначала зарегистрируйте участников командой /register.")
        return
    if gs["admin_id"] is None:
        gs["admin_id"] = msg.from_user.id
        gs["locked"] = True
        gs["quiz_started"] = True
        bump_rev(gs)
        bot.send_message(chat_id, f"🚀 Квиз начался! Админ: *{msg.from_user.first_name}*.\nПроверьте ЛС — там кнопка для входа в мини-приложение.")
    else:
        if gs["admin_id"] != msg.from_user.id:
            bot.send_message(chat_id, "Админ уже назначен. Дождитесь его действий.")
        else:
            bot.send_message(chat_id, "Вы уже админ этого квиза.")
    bot_username = bot.get_me().username
    for uid, p in gs["players"].items():
        try:
            send_webapp_button_to_user(uid, chat_id)
            p["dm_ok"] = True
        except Exception:
            p["dm_ok"] = False
            try:
                link_deep = deep_link(bot_username, chat_id)
                link_plain = f"https://t.me/{bot_username}"
                bot.send_message(chat_id, f"⚠️ {p['name']} — открой ЛС с ботом: {link_deep} (или {link_plain}) и нажми Start.")
            except Exception:
                pass

# === API: состояние, управление, ответы ===
def current_state_payload(gs, chat_id, user_id):
    role = "admin" if gs["admin_id"] == user_id else "player"
    rnd = gs["round"]
    payload = {
        "ok": True,
        "role": role,
        "players": {str(uid): {"name": p["name"], "answered": p["answered"]} for uid, p in gs["players"].items()},
        "scores": gs["scores"],
        "quiz_started": gs["quiz_started"],
        "locked": gs["locked"],
        "timer_seconds": gs["timer_seconds"],
        "rounds_total": gs.get("rounds_total", 10),
        "rounds_played": gs.get("rounds_played", 0),
        "admin_id": gs["admin_id"],
        "question": None,
        "round": None,
        "rev": gs.get("rev", 0)
    }
    if rnd:
        q = rnd["q"].copy()
        if not rnd["finished"]:
            q.pop("answer", None)
            q.pop("correct_text", None)

        ready = rnd.get("ready") or {}
        ready_total = len(ready)
        ready_required = max(1, math.ceil(0.8 * ready_total))
        ready_done = sum(1 for v in ready.values() if v)

        payload["question"] = q
        payload["round"] = {
            "started_at": rnd["started_at"],
            "question_at": rnd.get("question_at"),
            "deadline": rnd.get("deadline"),
            "finished": rnd["finished"],
            "countdown_sec": rnd.get("countdown_sec", COUNTDOWN_SEC),
            "ready_total": ready_total,
            "ready_done": ready_done,
            "ready_required": ready_required
        }
        if rnd["finished"]:
            payload["question"]["answer"] = rnd["q"]["answer"]
            payload["question"]["correct_text"] = rnd["q"]["correct_text"]
    return payload

@app.route("/api/get_state")
def get_state_api():
    try:
        chat_id = int(request.args.get("chat_id"))
        user_id = int(request.args.get("user_id"))
        gs = game_states.get(chat_id)
        if not gs:
            return jsonify({"ok": False, "ended": True}), 200
        if gs["round"] and gs["round"].get("deadline") is not None:
            finalize_round_if_needed(gs, chat_id)
        return jsonify(current_state_payload(gs, chat_id, user_id))
    except Exception as e:
        print(f"❌ /api/get_state error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/config", methods=["POST"])
def admin_config():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        timer_seconds = int(data["timer_seconds"])
        rounds_total = int(data.get("rounds_total", 10))

        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403

        gs["timer_seconds"] = max(MIN_TIMER, min(MAX_TIMER, timer_seconds))

        allowed_rounds = {10, 15, 20, 30}
        if rounds_total not in allowed_rounds:
            rounds_total = 10
        gs["rounds_total"] = rounds_total

        bump_rev(gs)
        return jsonify({"ok": True, "timer_seconds": gs["timer_seconds"], "rounds_total": gs["rounds_total"]})
    except Exception as e:
        print(f"❌ /api/admin/config error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/start", methods=["POST"])
def admin_start_round():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        maybe_timer = data.get("timer_seconds")
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403
        if not gs["quiz_started"]:
            return jsonify({"ok": False, "error": "quiz not started"}), 400
        if not gs.get("timer_seconds"):
            try:
                val = int(maybe_timer) if maybe_timer is not None else 30
            except Exception:
                val = 30
            gs["timer_seconds"] = max(MIN_TIMER, min(MAX_TIMER, val))

        # старт раунда в режиме ожидания подтверждений
        q = generate_question()
        started_at = time.time()
        gs["round"] = {
            "q": q,
            "started_at": started_at,
            "question_at": None,
            "deadline": None,
            "finished": False,
            "countdown_sec": COUNTDOWN_SEC,
            "ready": {str(uid): False for uid in gs["players"].keys()},
        }
        gs["rounds_played"] = 1
        for p in gs["players"].values():
            p["answered"] = False
            p["last_answer_time"] = None
        bump_rev(gs)
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/admin/start error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/next", methods=["POST"])
def admin_next():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403

        if gs["round"] and not gs["round"]["finished"] and gs["round"].get("deadline") is not None:
            finalize_round_if_needed(gs, chat_id)

        # Проверка лимита раундов
        played = gs.get("rounds_played", 0)
        total = gs.get("rounds_total", 10)
        if played >= total:
            board = compute_leaderboard(gs)

            lines = ["🏁 *Квиз завершён!* Итоговый лидерборд:"]
            if not board:
                lines.append("— никого нет в таблице 😅")
            else:
                score_groups = {}
                for _, name, score, ttime in board:
                    score_groups.setdefault(score, []).append((name, ttime))
                for i, (uid, name, score, ttime) in enumerate(board):
                    medal = medals_for_position(i)
                    addon = f" — по времени: {ttime:.2f} сек" if len(score_groups[score]) > 1 else ""
                    lines.append(f"{medal} *{name}* — {score} балл(ов){addon}")
            try:
                bot.send_message(chat_id, "\n".join(lines))
            except Exception:
                pass

            rematch_states[chat_id] = {
                "admin_id": gs["admin_id"],
                "confirmed": {},
                "leaderboard": [
                    {"user_id": uid, "name": name, "score": score, "total_time": ttime}
                    for uid, name, score, ttime in board
                ],
                "created_at": time.time()
            }
            game_states.pop(chat_id, None)
            return jsonify({"ok": True, "ended": True, "leaderboard": rematch_states[chat_id]["leaderboard"]})

        # Новый раунд в ожидании подтверждений
        q = generate_question()
        started_at = time.time()
        gs["round"] = {
            "q": q,
            "started_at": started_at,
            "question_at": None,
            "deadline": None,
            "finished": False,
            "countdown_sec": COUNTDOWN_SEC,
            "ready": {str(uid): False for uid in gs["players"].keys()},
        }
        gs["rounds_played"] = played + 1
        for p in gs["players"].values():
            p["answered"] = False
            p["last_answer_time"] = None
        bump_rev(gs)
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/admin/next error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/end", methods=["POST"])
def admin_end():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403

        if gs["round"] and not gs["round"]["finished"] and gs["round"].get("deadline") is not None:
            finalize_round_if_needed(gs, chat_id)

        board = compute_leaderboard(gs)
        lines = ["🏁 *Квиз завершён!* Итоговый лидерборд:"]
        if not board:
            lines.append("— никого нет в таблице 😅")
        else:
            score_groups = {}
            for _, name, score, ttime in board:
                score_groups.setdefault(score, []).append((name, ttime))
            for i, (uid, name, score, ttime) in enumerate(board):
                medal = medals_for_position(i)
                addon = f" — по времени: {ttime:.2f} сек" if len(score_groups[score]) > 1 else ""
                lines.append(f"{medal} *{name}* — {score} балл(ов){addon}")
        try:
            bot.send_message(chat_id, "\n".join(lines))
        except Exception:
            pass

        rematch_states[chat_id] = {
            "admin_id": gs["admin_id"],
            "confirmed": {},
            "leaderboard": [
                {"user_id": uid, "name": name, "score": score, "total_time": ttime}
                for uid, name, score, ttime in board
            ],
            "created_at": time.time()
        }

        game_states.pop(chat_id, None)
        return jsonify({"ok": True, "leaderboard": rematch_states[chat_id]["leaderboard"]})
    except Exception as e:
        print(f"❌ /api/admin/end error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/submit", methods=["POST"])
def submit_answer():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user"]["id"])
        given = int(data["given"])
        gs = game_states.get(chat_id)
        if not gs or not gs.get("round"):
            return jsonify({"ok": False}), 400
        rnd = gs["round"]
        if rnd["finished"]:
            return jsonify({"ok": False, "error": "round finished"}), 400
        if rnd.get("question_at") is None or time.time() < rnd["question_at"] - 0.05:
            return jsonify({"ok": False, "error": "not started"}), 400
        player = gs["players"].get(user_id)
        if not player or player["answered"]:
            return jsonify({"ok": False}), 400

        now = time.time()
        qstart = rnd.get("question_at", rnd["started_at"])
        elapsed = max(0.0, min(now, rnd["deadline"]) - qstart)
        player["last_answer_time"] = elapsed
        player["answered"] = True

        q = rnd["q"]
        if given == q["answer"]:
            gs["scores"][user_id] = gs["scores"].get(user_id, 0) + 1
        player["total_time"] += elapsed

        finalize_round_if_needed(gs, chat_id)
        bump_rev(gs)
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/submit error: {e}")
        return jsonify({"ok": False}), 500

# === API синхронизации старта ===
@app.route("/api/round/ready", methods=["POST"])
def round_ready():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or not gs.get("round"):
            return jsonify({"ok": False}), 400
        rnd = gs["round"]
        if rnd["finished"]:
            return jsonify({"ok": False, "error": "round finished"}), 400

        ready = rnd.setdefault("ready", {})
        key = str(user_id)
        if key not in ready:
            return jsonify({"ok": False, "error": "not in players"}), 403

        if not ready[key]:
            ready[key] = True
            bump_rev(gs)

        ready_total = len(ready)
        ready_done = sum(1 for v in ready.values() if v)
        ready_required = max(1, math.ceil(0.8 * ready_total))

        if ready_done >= ready_required and rnd.get("question_at") is None:
            go_at = time.time() + GO_SYNC_DELAY_SEC
            rnd["question_at"] = go_at
            rnd["deadline"] = go_at + (gs["timer_seconds"] or 30)
            bump_rev(gs)

        return jsonify({
            "ok": True,
            "ready_done": ready_done,
            "ready_total": ready_total,
            "ready_required": ready_required,
            "question_at": rnd.get("question_at"),
            "deadline": rnd.get("deadline")
        })
    except Exception as e:
        print(f"❌ /api/round/ready error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/force_start", methods=["POST"])
def admin_force_start():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id or not gs.get("round"):
            return jsonify({"ok": False, "error": "not admin"}), 403
        rnd = gs["round"]
        if rnd.get("question_at") is None:
            go_at = time.time() + GO_SYNC_DELAY_SEC
            rnd["question_at"] = go_at
            rnd["deadline"] = go_at + (gs["timer_seconds"] or 30)
            bump_rev(gs)
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/admin/force_start error: {e}")
        return jsonify({"ok": False}), 500

# === API рематча ===
@app.route("/api/rematch/state")
def rematch_state():
    try:
        chat_id = int(request.args.get("chat_id"))
        user_id = int(request.args.get("user_id"))
        rs = rematch_states.get(chat_id)
        if not rs:
            return jsonify({"ok": False}), 200
        return jsonify({
            "ok": True,
            "admin_id": rs["admin_id"],
            "confirmed": rs["confirmed"],
            "leaderboard": rs["leaderboard"],
            "im_in": str(user_id) in rs["confirmed"]
        })
    except Exception as e:
        print(f"❌ /api/rematch/state error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/rematch/join", methods=["POST"])
def rematch_join():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        name = data.get("name") or "Игрок"
        rs = rematch_states.get(chat_id)
        if not rs:
            return jsonify({"ok": False}), 400
        rs["confirmed"][str(user_id)] = name
        return jsonify({"ok": True, "confirmed": rs["confirmed"]})
    except Exception as e:
        print(f"❌ /api/rematch/join error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/rematch/leave", methods=["POST"])
def rematch_leave():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        rs = rematch_states.get(chat_id)
        if not rs:
            return jsonify({"ok": False}), 400
        rs["confirmed"].pop(str(user_id), None)
        return jsonify({"ok": True, "confirmed": rs["confirmed"]})
    except Exception as e:
        print(f"❌ /api/rematch/leave error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/rematch/start", methods=["POST"])
def rematch_start():
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        rs = rematch_states.get(chat_id)
        if not rs or rs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403
        confirmed = rs["confirmed"]

        # Создаём новую игру только с подтвердившими
        gs = ensure_chat_state(chat_id)
        gs["players"].clear()
        gs["scores"].clear()
        for uid_str, name in confirmed.items():
            uid = int(uid_str)
            gs["players"][uid] = {"name": name, "answered": False, "dm_ok": True, "total_time": 0.0, "last_answer_time": None}
            gs["scores"][uid] = 0
        gs["admin_id"] = rs["admin_id"]
        gs["quiz_started"] = True
        gs["locked"] = True
        gs["timer_seconds"] = None
        gs["rounds_total"] = gs.get("rounds_total", 10)
        gs["rounds_played"] = 0
        gs["round"] = None
        bump_rev(gs)

        for uid in gs["players"].keys():
            try: send_webapp_button_to_user(uid, chat_id)
            except Exception: pass

        rematch_states.pop(chat_id, None)
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/rematch/start error: {e}")
        return jsonify({"ok": False}), 500

# === Запуск ===
if __name__ == "__main__":
    try:
        bot.remove_webhook()
        time.sleep(1)

        if EXPLICIT_WEBHOOK_URL:
            webhook_url = EXPLICIT_WEBHOOK_URL
        else:
            host = os.getenv('RENDER_EXTERNAL_HOSTNAME')
            webhook_url = f"https://{host}/{TOKEN}" if host else None

        if webhook_url:
            print(f"🔄 Устанавливаю вебхук: {webhook_url}")
            bot.set_webhook(url=webhook_url)
            print("✅ Webhook установлен")
        else:
            print("ℹ️ Вебхук не настроен.")
    except Exception as e:
        print(f"❌ Ошибка вебхука: {e}")

    port = int(os.environ.get("PORT", 10000))
    print(f"🚀 Запускаю Flask на порту {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
