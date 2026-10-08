import json
import re
import time
from pathlib import Path
from urllib.request import urlopen


def main():
    path = Path(__file__).resolve().parents[1] / '.env.telegram'
    values = {}
    for line in path.read_text().splitlines():
        key, separator, value = line.partition('=')
        if separator:
            values[key] = value.strip()
    token = values.get('TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token):
        raise ValueError('Add your BotFather token to .env.telegram first')
    with urlopen('https://api.telegram.org/bot' + token + '/getUpdates', timeout=15) as response:
        data = json.loads(response.read(1000000))
    chats = set()
    for update in data.get('result', []):
        message = update.get('message', {})
        chat = message.get('chat', {})
        if chat.get('type') == 'private' and message.get('text') == '/pair_gem_search' and time.time() - message.get('date', 0) < 600:
            chats.add(chat['id'])
    if len(chats) != 1:
        raise ValueError('Send /pair_gem_search to your bot in a private chat, then run this again within 10 minutes')
    path.write_text('TELEGRAM_BOT_TOKEN=' + token + '\nTELEGRAM_CHAT_ID=' + str(chats.pop()) + '\n')
    print('Telegram paired locally. Restart is not required.')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error))
        raise SystemExit(1)
    except Exception:
        print('Telegram pairing unavailable. Check your local token and connection.')
        raise SystemExit(1)
