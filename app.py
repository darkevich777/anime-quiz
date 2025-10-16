import os
import time
import random
import requests
from flask import Flask, request, jsonify
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo

# === Конфигурация ===
TOKEN = os.getenv("BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("BOT_TOKEN не задан в переменных окружения")
WEBAPP_BASE = os.getenv("WEBAPP_BASE", "https://anime-quiz-hxkb.onrender.com/web/")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))  # не используется для фиксации, но оставим

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

# Вебхук для Telegram (опционально — зависит от хостинга)
@app.route('/webhook/', methods=['POST', 'GET'])
def webhook_handler():
    if request.method == 'POST':
        update = telebot.types.Update.de_json(request.stream.read().decode("utf-8"))
        bot.process_new_updates([update])
        return "ok", 200
    else:
        return "Webhook endpoint", 200

@app.route(f"/{TOKEN}", methods=["POST"])
def telegram_webhook():
    update = telebot.types.Update.de_json(request.stream.read().decode("utf-8"))
    bot.process_new_updates([update])
    return "ok", 200

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
        }
      }
    }
    """
    page = random.randint(1, 100)
    resp = requests.post(ANILIST_API, json={"query": query, "variables": {"page": page, "perPage": 50}})
    resp.raise_for_status()
    data = resp.json()
    return random.choice(data["data"]["Page"]["media"])

def generate_question():
    anime = fetch_anime_with_details()
    title = anime["title"]["romaji"]
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
        return {
            "question": f"К какому жанру относится аниме *{title}*?",
            "options": options, "answer": options.index(correct),
            "correct_text": correct
        }

    if q_type == "year" and anime.get("startDate") and anime["startDate"].get("year"):
        correct = anime["startDate"]["year"]
        options = {correct}
        while len(options) < 4:
            fake = correct + random.randint(-10, 10)
            if fake > 1950:
                options.add(fake)
        options = list(options)
        random.shuffle(options)
        return {
            "question": f"В каком году вышло аниме *{title}*?",
            "options": [str(x) for x in options],
            "answer": options.index(correct),
            "correct_text": str(correct)
        }

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
        return {
            "question": f"Какая студия выпустила аниме *{title}*?",
            "options": options, "answer": options.index(correct),
            "correct_text": correct
        }

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
        return {
            "question": f"Кто главный герой в аниме *{title}*?",
            "options": options, "answer": options.index(correct),
            "correct_text": correct
        }

    # на всякий случай — перегенерируем
    return generate_question()

# === Состояния игры ===
# Структура:
# chat_id: {
#   players: { uid: { name, answered(bool), dm_ok(bool), total_time(float), last_answer_time(float|None) } },
#   scores: { uid: int },
#   admin_id: int|None,
#   quiz_started: bool,
#   locked: bool,                # заморозка состава после начала
#   timer_seconds: int|None,     # выбран админом перед стартом
#   round: {
#       q: dict,
#       started_at: float (epoch),
#       deadline: float (epoch),
#       finished: bool
#   } | None
# }
game_states = {}

def ensure_chat_state(chat_id):
    if chat_id not in game_states:
        game_states[chat_id] = {
            "players": {},
            "scores": {},
            "admin_id": None,
            "quiz_started": False,
            "locked": False,
            "timer_seconds": None,
            "round": None
        }
    return game_states[chat_id]

def deep_link(bot_username, chat_id):
    return f"https://t.me/{bot_username}?start=join_{chat_id}"

def send_webapp_button_to_user(user_id, chat_id):
    params = f"?chat_id={chat_id}&user_id={user_id}"
    url = f"{WEBAPP_BASE}{params}"
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton(text="🎮 Открыть квиз", web_app=WebAppInfo(url=url)))
    bot.send_message(user_id, "Открываем квиз! Нажмите кнопку ниже:", reply_markup=markup)

def finalize_round_if_needed(gs, chat_id):
    """
    Закрывает раунд, если все ответили или таймер истёк.
    Начисляет «штрафное» время тем, кто не ответил (целая длительность).
    Отправляет подсказку о правильном ответе в группу.
    """
    rnd = gs["round"]
    if not rnd or rnd["finished"]:
        return

    now = time.time()
    all_answered = all(p["answered"] for p in gs["players"].values())
    timeout = now >= rnd["deadline"]
    if not all_answered and not timeout:
        return

    # Закрываем раунд
    rnd["finished"] = True

    # Добавить время тем, кто не ответил
    dur = gs["timer_seconds"] or 0
    for uid, p in gs["players"].items():
        if not p["answered"]:
            p["last_answer_time"] = None
            # «затраченное время» = полный таймер
            p["total_time"] += dur

    # Сообщение в чате о правильном ответе
    q = rnd["q"]
    bot.send_message(
        chat_id,
        f"🟩 Раунд завершён!\n"
        f"✅ Правильный ответ: *{q['correct_text']}*"
    )

def compute_leaderboard(gs):
    # возвращает список [(uid, name, score, total_time)], отсортированный по очкам desc, времени asc
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
    """
    Обработка deep-link /start join_<chatId> для завершения регистрации из группы.
    """
    text = msg.text or ""
    if "join_" in text:
        try:
            chat_id = int(text.split("join_")[1].strip())
        except Exception:
            bot.send_message(msg.chat.id, "Не удалось понять, из какой группы вы регистрируетесь.")
            return

        gs = ensure_chat_state(chat_id)
        uid = msg.from_user.id
        name = msg.from_user.first_name or "Игрок"

        if gs["locked"]:
            bot.send_message(msg.chat.id, "Квиз уже начался, новых участников добавить нельзя.")
            return

        if uid not in gs["players"]:
            gs["players"][uid] = {"name": name, "answered": False, "dm_ok": True, "total_time": 0.0, "last_answer_time": None}
            gs["scores"][uid] = 0
            bot.send_message(msg.chat.id, f"Отлично, {name}! Вы зарегистрированы в квизе.")
            try:
                bot.send_message(chat_id, f"✅ {name} теперь в игре!")
            except Exception:
                pass
        else:
            gs["players"][uid]["dm_ok"] = True
            bot.send_message(msg.chat.id, "Вы уже зарегистрированы. Удачи!")

@bot.message_handler(commands=["register"])
def register(msg):
    """
    Регистрация из группы. Если в ЛС написать нельзя — даём deep-link в группу.
    """
    chat_id = msg.chat.id
    if msg.chat.type not in ("group", "supergroup"):
        bot.send_message(chat_id, "Команда /register предназначена для группового чата.")
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

    # пробуем отправить ЛС, чтобы проверить, открыт ли диалог
    bot_username = bot.get_me().username
    try:
        bot.send_message(uid, "Привет! Вы зарегистрированы в квизе. Ожидайте начала игры.")
        dm_ok = True
    except Exception:
        dm_ok = False

    gs["players"][uid] = {"name": name, "answered": False, "dm_ok": dm_ok, "total_time": 0.0, "last_answer_time": None}
    gs["scores"][uid] = 0

    if dm_ok:
        bot.send_message(chat_id, f"✅ {name} зарегистрировался(лась).")
    else:
        link = deep_link(bot_username, chat_id)
        bot.send_message(
            chat_id,
            f"ℹ️ {name}, открой личный чат с ботом, чтобы участвовать: {link}\n"
            f"После нажатия *Start* вы будете добавлены автоматически."
        )

@bot.message_handler(commands=["status"])
def status(msg):
    chat_id = msg.chat.id
    gs = game_states.get(chat_id)
    if not gs:
        bot.send_message(chat_id, "Игра ещё не создана. Используйте /register для начала.")
        return

    lines = ["*Участники:*"]
    for p in gs["players"].values():
        lines.append(f"- {p['name']}")
    if not gs["players"]:
        lines.append("— пока никого 😅")
    bot.send_message(chat_id, "\n".join(lines))

@bot.message_handler(commands=["quiz"])
def quiz(msg):
    """
    Первый, кто вызывает /quiz в группе — становится админом.
    Квиз стартует (состав замораживается), всем уходит ЛС с кнопкой WebApp.
    """
    chat_id = msg.chat.id
    if msg.chat.type not in ("group", "supergroup"):
        bot.send_message(chat_id, "Команда /quiz предназначена для группового чата.")
        return

    gs = ensure_chat_state(chat_id)

    if not gs["players"]:
        bot.send_message(chat_id, "Сначала зарегистрируйте участников командой /register.")
        return

    if gs["admin_id"] is None:
        gs["admin_id"] = msg.from_user.id
        gs["locked"] = True
        gs["quiz_started"] = True
        bot.send_message(chat_id, f"🚀 Квиз начался! Админ: *{msg.from_user.first_name}*.\nПроверьте личные сообщения от бота — там кнопка для входа в игру.")
    else:
        if gs["admin_id"] != msg.from_user.id:
            bot.send_message(chat_id, "Админ уже назначен. Дождитесь управления от него.")
        else:
            bot.send_message(chat_id, "Вы уже админ этого квиза.")

    # Рассылаем кнопки в ЛС участникам (и админу тоже)
    bot_username = bot.get_me().username
    for uid, p in gs["players"].items():
        try:
            send_webapp_button_to_user(uid, chat_id)
            p["dm_ok"] = True
        except Exception:
            p["dm_ok"] = False
            try:
                link = deep_link(bot_username, chat_id)
                bot.send_message(chat_id, f"⚠️ {p['name']} — открой ЛС с ботом: {link}")
            except Exception:
                pass

# === API для мини-приложения ===

def current_state_payload(gs, chat_id, user_id):
    role = "admin" if gs["admin_id"] == user_id else "player"
    rnd = gs["round"]
    payload = {
        "ok": True,
        "role": role,
        "players": {
            str(uid): {
                "name": p["name"],
                "answered": p["answered"]
            } for uid, p in gs["players"].items()
        },
        "scores": gs["scores"],
        "quiz_started": gs["quiz_started"],
        "locked": gs["locked"],
        "timer_seconds": gs["timer_seconds"],
        "admin_id": gs["admin_id"],
        "question": None,
        "round": None
    }
    if rnd:
        # не раскрываем ответ до завершения
        q = rnd["q"].copy()
        if not rnd["finished"]:
            q.pop("answer", None)
            q.pop("correct_text", None)
        payload["question"] = q
        payload["round"] = {
            "started_at": rnd["started_at"],
            "deadline": rnd["deadline"],
            "finished": rnd["finished"]
        }
        # когда закончился — выдаём правильный ответ
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
            return jsonify({"ok": False}), 400

        # если идёт раунд — проверим авто-закрытие по таймеру
        if gs["round"]:
            finalize_round_if_needed(gs, chat_id)

        return jsonify(current_state_payload(gs, chat_id, user_id))
    except Exception as e:
        print(f"❌ /api/get_state error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/config", methods=["POST"])
def admin_config():
    """
    Устанавливает таймер перед началом (или между раундами).
    body: {chat_id, user_id, timer_seconds}
    """
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        timer_seconds = int(data["timer_seconds"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403
        gs["timer_seconds"] = max(5, min(300, timer_seconds))  # 5..300 сек
        return jsonify({"ok": True, "timer_seconds": gs["timer_seconds"]})
    except Exception as e:
        print(f"❌ /api/admin/config error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/start", methods=["POST"])
def admin_start_round():
    """
    Старт нового раунда (или первого).
    body: {chat_id, user_id}
    """
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403
        if not gs["quiz_started"]:
            return jsonify({"ok": False, "error": "quiz not started"}), 400
        if not gs.get("timer_seconds"):
            return jsonify({"ok": False, "error": "timer not set"}), 400

        # генерируем вопрос
        q = generate_question()
        started_at = time.time()
        deadline = started_at + gs["timer_seconds"]
        gs["round"] = {"q": q, "started_at": started_at, "deadline": deadline, "finished": False}
        # сбрасываем ответы
        for p in gs["players"].values():
            p["answered"] = False
            p["last_answer_time"] = None

        bot.send_message(chat_id, f"🕹️ Новый вопрос!\n{q['question']}\n⏳ Время: *{gs['timer_seconds']} сек*")
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/admin/start error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/next", methods=["POST"])
def admin_next():
    """
    Явное завершение текущего раунда, затем старт следующего.
    Если текущий ещё не закрыт — закрываем и тут же создаём новый.
    """
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403

        # закрыть текущий при необходимости
        if gs["round"] and not gs["round"]["finished"]:
            finalize_round_if_needed(gs, chat_id)

        # старт нового
        q = generate_question()
        started_at = time.time()
        deadline = started_at + (gs["timer_seconds"] or 30)
        gs["round"] = {"q": q, "started_at": started_at, "deadline": deadline, "finished": False}
        for p in gs["players"].values():
            p["answered"] = False
            p["last_answer_time"] = None

        bot.send_message(chat_id, f"➡️ Следующий вопрос!\n{q['question']}\n⏳ Время: *{gs['timer_seconds']} сек*")
        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/admin/next error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/admin/end", methods=["POST"])
def admin_end():
    """
    Завершение квиза. Вывод лидерборда в группу и возврат итогов во фронт.
    """
    try:
        data = request.get_json(force=True)
        chat_id = int(data["chat_id"])
        user_id = int(data["user_id"])
        gs = game_states.get(chat_id)
        if not gs or gs["admin_id"] != user_id:
            return jsonify({"ok": False, "error": "not admin"}), 403

        # закрыть текущий раунд, если открыт
        if gs["round"] and not gs["round"]["finished"]:
            finalize_round_if_needed(gs, chat_id)

        board = compute_leaderboard(gs)

        # Красиво выводим в группу
        lines = ["🏁 *Квиз завершён!* Итоговый лидерборд:"]
        if not board:
            lines.append("— никого нет в таблице 😅")
        else:
            # определим, были ли тай-брейки
            # строим группы по очкам
            score_groups = {}
            for _, name, score, ttime in board:
                score_groups.setdefault(score, []).append((name, ttime))
            for i, (uid, name, score, ttime) in enumerate(board):
                medal = medals_for_position(i)
                addon = ""
                # если в группе по таким же очкам больше 1 человека — укажем время
                if len(score_groups[score]) > 1:
                    addon = f" — по времени: {ttime:.2f} сек"
                lines.append(f"{medal} *{name}* — {score} балл(ов){addon}")

        bot.send_message(chat_id, "\n".join(lines))

        # Сбросим состояние игры (чтобы можно было начать новый позже)
        result_payload = {
            "ok": True,
            "leaderboard": [
                {"user_id": uid, "name": name, "score": score, "total_time": ttime}
                for uid, name, score, ttime in board
            ]
        }

        # Оставим admin_id и игроков нетронутыми? По ТЗ — квиз завершён; начинаем с нуля вручную.
        game_states.pop(chat_id, None)
        return jsonify(result_payload)
    except Exception as e:
        print(f"❌ /api/admin/end error: {e}")
        return jsonify({"ok": False}), 500

@app.route("/api/submit", methods=["POST"])
def submit_answer():
    """
    Принимаем ответ игрока.
    body: { chat_id, user: { id }, given }
    Время ответа — min(now, deadline) - started_at.
    Если не успел до дедлайна — будет добавлено полное время при финализации.
    """
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

        player = gs["players"].get(user_id)
        if not player or player["answered"]:
            return jsonify({"ok": False}), 400

        now = time.time()
        elapsed = max(0.0, min(now, rnd["deadline"]) - rnd["started_at"])
        player["last_answer_time"] = elapsed
        player["answered"] = True

        q = rnd["q"]
        if given == q["answer"]:
            gs["scores"][user_id] = gs["scores"].get(user_id, 0) + 1

        # суммируем время всегда (и для правильных, и для неправильных ответов)
        player["total_time"] += elapsed

        # если все ответили — финализируем
        finalize_round_if_needed(gs, chat_id)

        return jsonify({"ok": True})
    except Exception as e:
        print(f"❌ /api/submit error: {e}")
        return jsonify({"ok": False}), 500

# === Запуск локально (если нужно) ===
if __name__ == "__main__":
    try:
        bot.remove_webhook()
        time.sleep(1)
        webhook_url = f"https://{os.getenv('RENDER_EXTERNAL_HOSTNAME')}/{TOKEN}" if os.getenv('RENDER_EXTERNAL_HOSTNAME') else None
        if webhook_url:
            print(f"🔄 Устанавливаю вебхук: {webhook_url}")
            bot.set_webhook(url=webhook_url)
            print("✅ Webhook установлен")
        else:
            print("ℹ️ Вебхук не настроен (нет RENDER_EXTERNAL_HOSTNAME). Используйте polling/локальный запуск Flask.")
    except Exception as e:
        print(f"❌ Ошибка вебхука: {e}")

    port = int(os.environ.get("PORT", 10000))
    print(f"🚀 Запускаю Flask на порту {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
