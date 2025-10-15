import os
import random
import requests
from flask import Flask, request, jsonify
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
import threading

# === Конфигурация ===
TOKEN = os.getenv("BOT_TOKEN")
WEBAPP_BASE = os.getenv("WEBAPP_BASE", "https://anime-quiz-hxkb.onrender.com/web/")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))

bot = telebot.TeleBot(TOKEN)
app = Flask(__name__, static_url_path='', static_folder='web')

# === Маршруты для web ===
@app.route('/web/<path:path>')
def serve_web(path):
    return app.send_static_file(path)

@app.route('/web/')
def serve_web_index():
    return app.send_static_file('index.html')


# === Источник данных (Anilist API) ===
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
    data = resp.json()
    return random.choice(data["data"]["Page"]["media"])

def generate_question():
    anime = fetch_anime_with_details()
    title = anime["title"]["romaji"]

    q_type = random.choice(["genre", "year", "studio", "character"])

    if q_type == "genre" and anime["genres"]:
        correct = random.choice(anime["genres"])
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other["genres"]:
                g = random.choice(other["genres"])
                if g != correct and g not in wrongs:
                    wrongs.append(g)
        options = wrongs + [correct]
        random.shuffle(options)
        return {"question": f"К какому жанру относится аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct}

    if q_type == "year" and anime["startDate"] and anime["startDate"]["year"]:
        correct = anime["startDate"]["year"]
        options = [correct]
        while len(options) < 4:
            fake = correct + random.randint(-10, 10)
            if fake not in options and fake > 1950:
                options.append(fake)
        random.shuffle(options)
        return {"question": f"В каком году вышло аниме *{title}*?",
                "options": [str(x) for x in options], "answer": options.index(correct),
                "correct_text": str(correct)}

    if q_type == "studio" and anime["studios"]["nodes"]:
        correct = anime["studios"]["nodes"][0]["name"]
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other["studios"]["nodes"]:
                st = other["studios"]["nodes"][0]["name"]
                if st != correct and st not in wrongs:
                    wrongs.append(st)
        options = wrongs + [correct]
        random.shuffle(options)
        return {"question": f"Какая студия выпустила аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct}

    if q_type == "character" and anime["characters"]["nodes"]:
        correct = anime["characters"]["nodes"][0]["name"]["full"]
        wrongs = []
        while len(wrongs) < 3:
            other = fetch_anime_with_details()
            if other["characters"]["nodes"]:
                ch = other["characters"]["nodes"][0]["name"]["full"]
                if ch != correct and ch not in wrongs:
                    wrongs.append(ch)
        options = wrongs + [correct]
        random.shuffle(options)
        return {"question": f"Кто главный герой в аниме *{title}*?",
                "options": options, "answer": options.index(correct),
                "correct_text": correct}

    return generate_question()


# === Состояния игры ===
game_states = {}  # chat_id -> {players, scores, question, admin_id}

# === Команды бота ===
@bot.message_handler(commands=["register"])
def register(msg):
    chat_id = msg.chat.id
    if chat_id not in game_states:
        game_states[chat_id] = {"players": {}, "scores": {}, "question": None, "admin_id": msg.from_user.id}

    gs = game_states[chat_id]
    if msg.from_user.id not in gs["players"]:
        gs["players"][msg.from_user.id] = {"name": msg.from_user.first_name, "answered": False}
        gs["scores"][msg.from_user.id] = 0
        bot.send_message(chat_id, f"{msg.from_user.first_name} зарегистрировался ✅")
    else:
        bot.send_message(chat_id, "Ты уже участвуешь!")

@bot.message_handler(commands=["quiz"])
def quiz(msg):
    print(f"🚨 /quiz вызван в чате {msg.chat.id}")
    
    try:
        # Простейшая версия - просто отправляем сообщение
        bot.send_message(msg.chat.id, "✅ Команда /quiz работает!")
        
        # Пробуем отправить кнопку без сложной логики
        test_url = "https://example.com"  # временная тестовая ссылка
        markup = InlineKeyboardMarkup()
        markup.add(InlineKeyboardButton("🎮 ТЕСТ Квиз", web_app=WebAppInfo(url=test_url)))
        
        bot.send_message(msg.chat.id, "Проверка кнопки:", reply_markup=markup)
        print("✅ Сообщения отправлены!")
        
    except Exception as e:
        print(f"❌ Ошибка в /quiz: {e}")
        bot.send_message(msg.chat.id, f"Ошибка: {str(e)}")


# === API ===
@app.route("/api/get_state")
def get_state():
    chat_id = int(request.args.get("chat_id"))
    user_id = int(request.args.get("user_id"))
    gs = game_states.get(chat_id)
    if not gs:
        return jsonify({"ok": False}), 400
    role = "admin" if gs.get("admin_id") == user_id else "player"
    return jsonify({"ok": True, "role": role, "players": gs["players"], "question": gs["question"], "scores": gs["scores"]})

@app.route("/api/admin/start", methods=["POST"])
def admin_start():
    data = request.json
    chat_id = int(data["chat_id"])
    user_id = int(data["user_id"])
    gs = game_states.get(chat_id)
    if not gs or gs.get("admin_id") != user_id:
        return jsonify({"ok": False, "error": "not admin"}), 403

    q = generate_question()
    gs["question"] = q
    for p in gs["players"].values():
        p["answered"] = False

    label = "Начать первый раунд" if all(s == 0 for s in gs["scores"].values()) else "Следующий вопрос"
    bot.send_message(chat_id, f"🎯 Новый раунд начался!\n{q['question']}")
    return jsonify({"ok": True, "question": q, "button": label})

@app.route("/api/submit", methods=["POST"])
def submit_answer():
    data = request.json
    chat_id = int(data["chat_id"])
    user_id = int(data["user"]["id"])
    given = data["given"]

    gs = game_states.get(chat_id)
    if not gs or not gs.get("question"):
        return jsonify({"ok": False}), 400

    q = gs["question"]
    player = gs["players"].get(user_id)
    if not player or player["answered"]:
        return jsonify({"ok": False}), 400

    player["answered"] = True
    if given == q["answer"]:
        gs["scores"][user_id] += 1

    # если все ответили
    if all(p["answered"] for p in gs["players"].values()):
        lines = [f"✅ Правильный ответ: *{q['correct_text']}*",
                 "🏁 Раунд завершён!"]
        for uid, pl in gs["players"].items():
            lines.append(f"{pl['name']}: {gs['scores'][uid]} очков")
        bot.send_message(chat_id, "\n".join(lines), parse_mode="Markdown")

    return jsonify({"ok": True})

@app.route("/api/admin/reset", methods=["POST"])
def admin_reset():
    data = request.json
    chat_id = int(data["chat_id"])
    user_id = int(data["user_id"])
    gs = game_states.get(chat_id)
    if not gs or gs.get("admin_id") != user_id:
        return jsonify({"ok": False, "error": "not admin"}), 403
    gs["players"].clear()
    gs["scores"].clear()
    gs["question"] = None
    return jsonify({"ok": True})
    
@app.route("/set_webhook")
def set_webhook():
    host = os.getenv("RENDER_EXTERNAL_HOSTNAME")
    if not host:
        return "❌ Нет хоста", 500
    webhook_url = f"https://{host}/{TOKEN}"
    ok = bot.set_webhook(url=webhook_url)
    return f"✅ Webhook установлен: {webhook_url}" if ok else "❌ Ошибка установки"


# === Запуск ===
if __name__ == "__main__":
    import time
    
    # ВРЕМЕННО переключаемся на поллинг для отладки
    print("🔄 Запускаем бота в режиме POLLING...")
    bot.remove_webhook()
    time.sleep(1)
    
    # Добавляем тестовую команду для проверки
    @bot.message_handler(commands=["test"])
    def test_cmd(msg):
        print(f"✅ Тестовая команда работает! Чат: {msg.chat.id}")
        bot.send_message(msg.chat.id, "✅ Бот жив! Тест пройден.")
    
    try:
        bot.infinity_polling()
    except Exception as e:
        print(f"❌ Ошибка поллинга: {e}")

