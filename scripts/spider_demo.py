#!/usr/bin/env python3
"""Terminal walkthrough for demos: walk the sample feed, send it to a running engine, log what JEV finds.

Everything after the walk comes from the real engine: the captures go through
the extension API, and leads, checks and events are read back from /api/state.
The posts themselves are the fictional ones from sample_signals.py.
Colors use the 256-color palette, which macOS Terminal and iTerm both render.
"""
import argparse
import colorsys
import json
import os
from pathlib import Path
import sys
import time
from datetime import datetime
from urllib.error import URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sample_signals import ROOT, sample_posts

COLOR = (sys.stdout.isatty() or bool(os.getenv('FORCE_COLOR'))) and not os.getenv('NO_COLOR')
RESET = '\033[0m'


def c256(r, g, b):
    return 16 + 36 * round(r / 255 * 5) + 6 * round(g / 255 * 5) + round(b / 255 * 5)


def hue(position):
    """Pink → orange → yellow → green → cyan → violet, like the banner."""
    r, g, b = colorsys.hsv_to_rgb((0.95 + position * 0.8) % 1, 0.55, 1)
    return c256(r * 255, g * 255, b * 255)


PINK, AMBER, MINT, VIOLET, MAGENTA, GRAY, WHITE = 211, 222, 122, 141, 213, 245, 255
TAGS = {'spider': PINK, 'jev': AMBER, 'engine': GRAY, 'lead': MINT, 'check': VIOLET, 'done': MAGENTA}
KINDS = {'phrase': ('NEW NARRATIVE', 120), 'ticker': ('TICKER', 211), 'contract': ('CONTRACT', 222), 'topic': ('TOPIC', 117)}

LETTERS = {
    'G': [' ████', '█    ', '█  ██', '█   █', ' ████'],
    'E': ['█████', '█    ', '████ ', '█    ', '█████'],
    'M': ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
    'S': [' ████', '█    ', ' ███ ', '    █', '████ '],
    'A': [' ███ ', '█   █', '█████', '█   █', '█   █'],
    'R': ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
    'C': [' ████', '█    ', '█    ', '█    ', ' ████'],
    'H': ['█   █', '█   █', '█████', '█   █', '█   █'],
}
SPIDER = [
    r'  \   \    /   /  ',
    r'___\   \  /   /___',
    r'    \  (oo)  /    ',
    r'____/ /    \ \____',
    r'   /  /    \  \   ',
    r'  /  /      \  \  ',
]


def fg(code, text, bold=False):
    return f"\033[{'1;' if bold else ''}38;5;{code}m{text}{RESET}" if COLOR else text


def dim(text):
    return fg(GRAY, text)


def gradient(text, offset=0.0, bold=True):
    if not COLOR:
        return text
    width = max(1, len(text) - 1)
    return ''.join(fg(hue(offset + i / width), ch, bold) if ch.strip() else ch for i, ch in enumerate(text))


def rule(width=96):
    print(gradient('━' * width, bold=False))


def banner():
    word = 'GEMSEARCH'
    rows = [' '.join(LETTERS[ch][row] for ch in word) for row in range(5)]
    print()
    for i in range(6):
        leg = SPIDER[i]
        left = ''.join(fg(hue(i / 6), ch, True) if ch not in ' ()o' else fg(WHITE, ch, True) if ch.strip() else ch for ch in leg)
        right = gradient(rows[i - 1]) if 1 <= i <= 5 else ''
        print('  ' + left + '    ' + right)
    print()
    print('  ' + gradient('the narrative spider', 0.1) + dim('  ·  emerging signals walkthrough  ·  local engine, receipts kept'))
    rule()


def log(tag, message, pause=0.0):
    stamp = dim(datetime.now().strftime('%H:%M:%S'))
    print(f"{stamp} {fg(TAGS[tag], f'[{tag}]'.ljust(9), True)} {message}", flush=True)
    time.sleep(pause)


def call(base, path, body=None, key=''):
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['X-Gem-Extension'] = key
    data = None if body is None else json.dumps(body).encode()
    with urlopen(Request(base + path, data, headers), timeout=10) as response:
        return json.loads(response.read())


def ago(seconds):
    hours = (time.time() - seconds) / 3600
    return f'{hours:.0f}h ago' if hours >= 1 else f'{hours * 60:.0f}m ago'


def sparkline(recent, previous):
    """Six bars: the 18h before (thin) and the last 6h (tall), scaled to the larger pace."""
    before, now = previous / 18, recent / 6
    top = max(before, now, 1e-9)
    bars = '▁▂▃▄▅▆▇█'
    cells = [before] * 3 + [now] * 3
    return ''.join(fg(hue(i / 6), bars[min(7, round(v / top * 7))]) for i, v in enumerate(cells))


def wait_for_engine(base, started, after_events):
    """Animate a rainbow bar until the spider loop has processed everything we sent."""
    width, frame, state = 36, 0, None
    deadline = time.time() + 60
    while time.time() < deadline:
        state = call(base, '/api/state')
        fresh = [e for e in state['events'] if e['id'] > after_events]
        done = state['spider']['pending'] == 0 and not state['state']['running'] and any('SPIDER: processed' in e['message'] for e in fresh)
        if done:
            break
        if COLOR:
            filled = frame % (width + 1)
            bar = ''.join(fg(hue((i + frame) / width), '█') for i in range(filled)) + dim('░' * (width - filled))
            elapsed = time.time() - started
            print(f"\r{dim(datetime.now().strftime('%H:%M:%S'))} {fg(AMBER, '[jev]'.ljust(9), True)} {bar} {dim(f'{elapsed:4.1f}s')}", end='', flush=True)
        frame += 1
        time.sleep(.08)
    if COLOR:
        print('\r' + ' ' * 80 + '\r', end='')
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--speed', type=float, default=1.0, help='2 = twice as fast')
    args = parser.parse_args()
    base = f'http://127.0.0.1:{args.port}'
    step = .4 / max(args.speed, .1)
    banner()
    try:
        key = (ROOT / 'data' / 'extension-key').read_text().strip()
        before = call(base, '/api/state')
    except (OSError, URLError):
        sys.exit(f'Engine is not reachable on {base}. Start it first: python3 app.py')
    last_event = max((e['id'] for e in before['events']), default=0)
    grok = (before.get('grok') or {}).get('enabled')
    log('engine', f"connected to {fg(MAGENTA, base, True)}  ·  Grok {'on' if grok else 'off · local checks only'}", step)
    log('spider', gradient('released on the visible feed') + dim('  ·  walking between posts'), step * 1.5)

    posts = sorted(sample_posts(), key=lambda p: p['created_at'])
    for post in posts:
        author = '@' + post['url'].split('/')[3]
        stamp = datetime.fromisoformat(post['created_at']).timestamp()
        text = post['text'].replace(' (sample)', '')
        text = text if len(text) <= 60 else text[:57] + '…'
        for word in ('$WEBZ', 'rainbow spiders'):
            text = text.replace(word, fg(MAGENTA, word, True))
        log('spider', f"{fg(PINK, '●')} {fg(WHITE, author.ljust(17), True)} {dim(ago(stamp).rjust(7))}  {text}", step)

    result = call(base, '/api/extension/ingest', {'posts': posts}, key)
    if not result['accepted']:
        log('engine', fg(PINK, 'nothing new: these sample posts were captured before.', True))
        log('engine', 'for a clean run stop the engine, delete the data folder, start it again.')
        return
    log('spider', f"{fg(MINT, '✔', True)} sent {len(posts)} captures  ·  engine accepted {fg(MINT, str(result['accepted']), True)}"
        + (dim(f"  ·  {result['duplicates']} duplicates") if result['duplicates'] else ''), step)
    log('jev', 'dedup by status id  ·  grouping topics, $tickers, Solana addresses, new phrases', step)
    state = wait_for_engine(base, time.time(), last_event)

    for event in sorted((e for e in state['events'] if e['id'] > last_event), key=lambda e: e['id']):
        log('engine', dim(event['message']), step / 3)
    rule()

    leads = [p for p in state['projects'] if p.get('source') == 'spider' and p.get('kind')]
    order = {'phrase': 0, 'ticker': 1, 'contract': 2, 'topic': 3}
    for p in sorted(leads, key=lambda p: (order.get(p['kind'], 9), -p['signals']['authors'])):
        s = p['signals']
        label, color = KINDS[p['kind']]
        bar = fg(color, '┃', True)
        growth = f"×{s['growth']}" if s.get('growth') is not None else '-'
        verdict = {'shortlisted': fg(MINT, 'SHORTLIST', True), 'held': fg(AMBER, 'NEEDS DATA', True), 'rejected': fg(PINK, 'REJECTED', True)}[p['status']]
        checks = '  '.join((fg(MINT, '✔') if v['vote'] == 'pass' else fg(AMBER, '…') if v['vote'] == 'hold' else fg(PINK, '✖')) + ' ' + v['seat'] for v in p['votes'])
        log('lead', f"{bar} {fg(color, label.ljust(14), True)}{fg(WHITE, p['name'], True)}", step / 3)
        log('lead', f"{bar} {dim('mentions')} {s['mentions']}  {dim('authors')} {s['authors']}  {dim('last 6h')} {s['recent']}  "
            f"{dim('pace')} {fg(MAGENTA, growth, True)}  {sparkline(s['recent'], s['previous'])}", step / 3)
        log('check', f"{bar} {checks}  {dim('→')} {verdict}" + (dim('  · research only') if p.get('research_only') else ''), step)

    rule()
    fastest = max(leads, key=lambda p: p['signals'].get('growth') or 0, default=None)
    if fastest and fastest['signals'].get('growth'):
        log('done', gradient(f"fastest growing  ✦  {fastest['name']}  ✦  ×{fastest['signals']['growth']}"), step)
    log('done', f"{len(leads)} leads ready  ·  open {fg(MAGENTA, base, True)}  →  Discovery  →  sort by {gradient('Fastest growing')}")
    print()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print(RESET + '\n' + dim('stopped'))
