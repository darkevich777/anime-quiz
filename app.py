import os
import random
import requests
from flask import Flask, request, jsonify
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

# -----------------------
# Конфигурация
# -----------------------
TOKEN = os.getenv("BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("Set BOT_TOKEN env var")

# Полный URL к webapp (должен указывать на index.html)
WEBAPP_BASE = os.getenv("WEBAPP_BASE", "https://anime-quiz-hxkb.onrender.com/web/index.html")
# URL куда Telegram будет слать webhook (должен быть HTTPS и доступен)
WEBHOOK_URL = os.getenv("WEBHOOK_URL")  # например https://anime-quiz-hxkb.onrender.com/webhook
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))

bot = telebot.TeleBot(TOKEN, threaded=False)

# Flask отдаёт статику из web/
app = Flask(__name__, static_url_path='', static_folder='web')

@app.route('/web/<path:path>')
def serve_web(path):
    return app.send_static_file(path)

@app.route('/web/')
def serve_web_index():
    return app.send_static_file('index.html')

# -----------------------
# State (in-memory)
# -----------------------
# game_states: chat_id -> {
#    players: {user_id: {"name":..., "answered": bool}},
#    scores: {user_id: int},
#    question: {"question": str, "options": [..], "answer": idx} or None
# }
game_states = {}

ANILIST_API = "https://graphql.anilist.co"

# -----------------------
# Helper: fetch/generate question
# -----------------------
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
    variables = {"page": page, "perPage": 50}
    try:
        resp = requests.post(ANILIST_API, json={"query": query, "variables": variables}, timeout=10)
        data = resp.json()
        return random.choice(data["data"]["Page"]["media"])
    except Exception:
        # fallback simple
        return {
            "title": {"romaji": "Naruto"},
            "startDate": {"year": 2002},
            "genres": ["Action", "Adventure"],
            "studios": {"nodes": [{"name": "Studio Pierrot"}]},
            "characters": {"nodes": [{"name": {"full": "Naruto Uzumaki"}}]}
        }

def generate_question():
    anime = fetch_anime_with_details()
    title = anime["title"].get("romaji") if isinstance(anime["title"], dict) else anime["title"]
    q_type = random.choice(["genre", "year", "studio", "character"])

    # genre
    if q_type == "genre" and anime.get("genres"):
        correct = random.choice(anime["genres"])
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("genres"):
                g = random.choice(other["genres"])
                if g != correct and g not in wrongs:
                    wrongs.append(g)
        opts = wrongs + [correct]
        random.shuffle(opts)
        return {"question": f"К какому жанру относится аниме «{title}»?", "options": opts, "answer": opts.index(correct)}

    # year
    if q_type == "year" and anime.get("startDate") and anime["startDate"].get("year"):
        correct = anime["startDate"]["year"]
        opts = [correct]
        while len(opts) < 4:
            fake = correct + random.randint(-8, 8)
            if fake not in opts and fake > 1950:
                opts.append(fake)
        random.shuffle(opts)
        return {"question": f"В каком году вышло аниме «{title}»?", "options": [str(x) for x in opts], "answer": opts.index(correct)}

    # studio
    if q_type == "studio" and anime.get("studios") and anime["studios"].get("nodes"):
        correct = anime["studios"]["nodes"][0]["name"]
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("studios") and other["studios"].get("nodes"):
                st = other["studios"]["nodes"][0]["name"]
                if st != correct and st not in wrongs:
                    wrongs.append(st)
        opts = wrongs + [correct]
        random.shuffle(opts)
        return {"question": f"Какая студия выпустила аниме «{title}»?", "options": opts, "answer": opts.index(correct)}

    # character
    if q_type == "character" and anime.get("characters") and anime["characters"].get("nodes"):
        correct = anime["characters"]["nodes"][0]["name"]["full"]
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other.get("characters") and other["characters"].get("nodes"):
                ch = other["characters"]["nodes"][0]["name"]["full"]
                if ch != correct and ch not in wrongs:
                    wrongs.append(ch)
        opts = wrongs + [correct]
        random.shuffle(opts)
        return {"question": f"Кто главный герой в аниме «{title}»?", "options": opts, "answer": opts.index(correct)}

    # fallback
    return {"question": "Что-то пошло не так, сгенерируйте вопрос снова.", "options": ["—","—","—","—"], "answer": 0}

# -----------------------
# Telegram commands (webhook mode)
# -----------------------
@bot.message_handler(commands=["register"])
def register(msg):
    chat_id = msg.chat.id
    user = msg.from_user
    gs = game_states.setdefault(chat_id, {"players": {}, "scores": {}, "question": None, "admin_id": msg.from_user.id})
    if user.id not in gs["players"]:
        gs["players"][user.id] = {"name": user.first_name or user.username or str(user.id), "answered": False}
        gs["scores"].setdefault(user.id, 0)
        bot.send_message(chat_id, f"{gs['players'][user.id]['name']} зарегистрировался ✅")
    else:
        bot.send_message(chat_id, "Ты уже зарегистрирован.")

@bot.message_handler(commands=["status"])
def status(msg):
    chat_id = msg.chat.id
    gs = game_states.get(chat_id)
    if not gs:
        bot.send_message(chat_id, "Игры нет. Зарегистрируйтесь с помощью /register")
        return
    lines = ["Участники:"]
    for u,p in gs["players"].items():
        lines.append(f"- {p['name']} {'(ответил)' if p['answered'] else '(ждёт)'}")
    bot.send_message(chat_id, "\n".join(lines))

@bot.message_handler(commands=["quiz"])
def quiz_cmd(msg):
    # в группах web_app field запрещён — используем обычную URL-кнопку, открывающую WebView в Telegram
    chat_id = msg.chat.id
    gs = game_states.get(chat_id)
    if not gs:
        bot.send_message(chat_id, "Сначала зарегистрируйтесь командой /register")
        return
    # формируем URL с параметрами chat_id и user_id — польза: фронт знает контекст
    params = f"?chat_id={chat_id}&user_id={msg.from_user.id}"
    url = f"{WEBAPP_BASE}{params}"
    markup = InlineKeyboardMarkup()
    markup.add(InlineKeyboardButton("🎮 Открыть квиз", url=url))
    bot.send_message(chat_id, "Нажмите кнопку, чтобы открыть квиз (WebApp):", reply_markup=markup)

# -----------------------
# API для WebApp (frontend)
# -----------------------
@app.route("/api/get_state")
def api_get_state():
    chat_id = request.args.get("chat_id", type=int)
    user_id = request.args.get("user_id", type=int)
    if chat_id is None or user_id is None:
        return jsonify({"ok": False, "error": "missing_params"}), 400
    gs = game_states.get(chat_id)
    if not gs:
        return jsonify({"ok": False, "error": "no_game"}), 404
    role = "admin" if gs.get("admin_id") == user_id or user_id == ADMIN_ID else "player"
    # serialize players
    players_serial = {str(uid): {"name": p["name"], "answered": p["answered"]} for uid,p in gs["players"].items()}
    return jsonify({"ok": True, "role": role, "players": players_serial, "question": gs["question"], "scores": gs["scores"]})

@app.route("/api/admin/start", methods=["POST"])
def api_admin_start():
    data = request.json
    chat_id = int(data.get("chat_id"))
    user_id = int(data.get("user_id"))
    gs = game_states.get(chat_id)
    if not gs or (gs.get("admin_id") != user_id and user_id != ADMIN_ID):
        return jsonify({"ok": False, "error": "not_admin"}), 403
    q = generate_question()
    gs["question"] = q
    # reset answered flags
    for p in gs["players"].values():
        p["answered"] = False
    # notify group
    try:
        # build a short preview to post in chat
        preview = q["question"] + "\n\nВарианты:\n" + "\n".join([f"{i+1}. {o}" for i,o in enumerate(q["options"])])
        bot.send_message(chat_id, "Новый раунд! " + preview)
    except Exception as e:
        print("Failed to send preview message:", e)
    return jsonify({"ok": True, "question": q})

@app.route("/api/admin/reset", methods=["POST"])
def api_admin_reset():
    data = request.json
    chat_id = int(data.get("chat_id"))
    user_id = int(data.get("user_id"))
    gs = game_states.get(chat_id)
    if not gs or (gs.get("admin_id") != user_id and user_id != ADMIN_ID):
        return jsonify({"ok": False, "error": "not_admin"}), 403
    gs["players"].clear()
    gs["scores"].clear()
    gs["question"] = None
    return jsonify({"ok": True})

@app.route("/api/submit", methods=["POST"])
def api_submit():
    data = request.json
    chat_id = int(data.get("chat_id"))
    user = data.get("user") or {}
    user_id = int(user.get("id"))
    given = int(data.get("given"))
    gs = game_states.get(chat_id)
    if not gs:
        return jsonify({"ok": False, "error": "no_game"}), 404
    if user_id not in gs["players"]:
        return jsonify({"ok": False, "error": "not_registered"}), 403
    if gs["players"][user_id]["answered"]:
        return jsonify({"ok": False, "error": "already_answered"}), 400
    # register answer
    gs["players"][user_id]["answered"] = True
    q = gs["question"]
    if q and given == q["answer"]:
        gs["scores"][user_id] = gs["scores"].get(user_id, 0) + 1
    # check if all answered
    if all(p["answered"] for p in gs["players"].values()):
        # publish results
        lines = ["Раунд завершён! Результаты:"]
        for uid,p in gs["players"].items():
            lines.append(f"{p['name']}: {gs['scores'].get(uid,0)}")
        bot.send_message(chat_id, "\n".join(lines))
    return jsonify({"ok": True})

# -----------------------
# Webhook endpoint for Telegram
# -----------------------
@app.route("/webhook", methods=["POST"])
def webhook():
    json_str = request.get_data().decode("utf-8")
    if not json_str:
        return "", 400
    update = telebot.types.Update.de_json(json_str)
    bot.process_new_updates([update])
    return "", 200

# -----------------------
# Startup: set webhook if provided
# -----------------------
if __name__ == "__main__":
    # set webhook if WEBHOOK_URL is provided
    if WEBHOOK_URL:
        try:
            bot.remove_webhook()
            bot.set_webhook(url=WEBHOOK_URL)
            print("Webhook set to:", WEBHOOK_URL)
        except Exception as e:
            print("Failed to set webhook:", e)
    else:
        print("Warning: WEBHOOK_URL not set. Bot will not receive updates unless webhook configured.")

    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
