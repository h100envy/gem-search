<p align="center"><img src="docs/banner.svg" alt="Gem Search - a rainbow spider that follows the evidence" width="100%"></p>

## Windows token monitor

This standalone desktop project builds on [h100envy/gem-search](https://github.com/h100envy/gem-search). Original history and MIT licensing are preserved. The earlier fork and historical downloads remain available at [gem-search](https://github.com/nightangelflowerwin-ops/gem-search).

The Windows app includes a read-only MCP connection for compatible assistants. Anyone can connect their own local app using Assistant connection in the sidebar. See [MCP setup and tools](docs/MCP.md).

The desktop app provides a workspace for tokens, watchlists, saved records and notification controls. Start monitoring manually, then stop it manually or choose a time limit. Download the Windows preview from [Releases](https://github.com/nightangelflowerwin-ops/gem-search-desktop/releases). See [desktop usage](docs/DESKTOP.md) for setup and limitations.

<p align="center">
  <a href="https://github.com/nightangelflowerwin-ops/gem-search-desktop/actions/workflows/ci.yml"><img src="https://github.com/nightangelflowerwin-ops/gem-search-desktop/actions/workflows/ci.yml/badge.svg" alt="Checks"></a>
  <img src="https://img.shields.io/badge/Chrome-Manifest_V3-ff95b1?labelColor=191922" alt="Chrome Manifest V3">
  <img src="https://img.shields.io/badge/local-first-91e5c7?labelColor=191922" alt="Local first">
  <img src="https://img.shields.io/badge/Grok-4_perspectives-bca4ff?labelColor=191922" alt="Four optional Grok reviewers">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-f1cf8a?labelColor=191922" alt="MIT license"></a>
  <a href="https://pump.fun/coin/GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump"><img src="https://img.shields.io/badge/token-$GEMSEARCH-4dff6a?labelColor=191922" alt="$GEMSEARCH on Solana"></a>
  <a href="https://t.me/gemsearchfunbot"><img src="https://img.shields.io/badge/Telegram-@gemsearchfunbot-1fd2ff?labelColor=191922&logo=telegram&logoColor=white" alt="Telegram bot"></a>
  <a href="https://x.com/gemsearchfun"><img src="https://img.shields.io/badge/X-@gemsearchfun-f4f0ff?labelColor=191922&logo=x&logoColor=white" alt="Follow @gemsearchfun on X"></a>
</p>

<h1 align="center">🕷️ Meet the curious side of your feed.</h1>
<p align="center"><b>Your next research rabbit hole has eight legs.</b><br>A browser companion that turns the posts you see into questions worth asking, plus free on-chain tools, a launchpad for two chains and a Telegram bot at <a href="https://gemsearch.fun">gemsearch.fun</a>.</p>
<p align="center"><a href="#-latest-updates">Latest</a> · <a href="#-gemsearch-the-token">$GEMSEARCH</a> · <a href="#%EF%B8%8F-the-spider-on-the-web-tools-at-gemsearchfun">Tools</a> · <a href="#-launch-a-coin-from-gemsearchfun">Launchpad</a> · <a href="#-whats-new-the-spider-catches-it-early">What's new</a> · <a href="#quick-start">Get started</a> · <a href="docs/README.ru.md">Русский</a> · <a href="docs/ARCHITECTURE.md">Architecture</a> · <a href="docs/PRIVACY.md">Privacy</a> · <a href="https://gemsearch.fun">gemsearch.fun</a> · <a href="https://x.com/gemsearchfun">X @gemsearchfun</a></p>

<br>

<table>
<tr>
<td width="33%" valign="top"><h3>🌈 A companion, with character</h3>A spider walks through your feed, pauses on a post and shows what it is investigating. You can see the work happening.</td>
<td width="33%" valign="top"><h3>🔎 Every lead has a trail</h3>Posts, public links, checks and unknowns stay attached to the finding. Open the source. Challenge the conclusion.</td>
<td width="33%" valign="top"><h3>🏡 Your computer is home</h3>The engine and database run locally. Add your own Grok key when you want model reviews. No hosted Gem Search account.</td>
</tr>
</table>

<br>

## 🆕 Latest updates

| | |
| --- | --- |
| 🟢 **Robinhood Chain launches** | The launchpad now speaks two chains: Solana via pump.fun and Robinhood Chain via pons, from one form. The first Robinhood launch went through clean |
| 🕷️ **Spider's chain pick** | The launch page tells you where to launch right now, from the last 24h of launches and graduations on both chains, plus the mood on X |
| 🔥 **Burn** | [gemsearch.fun/burn](https://gemsearch.fun/burn): burn $GEMSEARCH from your wallet in one click, with a live counter of every burn |
| 🏆 **Launch Cup** | [gemsearch.fun/cup](https://gemsearch.fun/cup): $50 / $20 / $10 every week for the most successful coins launched on gemsearch.fun. `/cup` in the bot |
| 🌈 **Crawling spiders** | Rainbow spiders walk across every page of the site, frame a block and spin threads to it |

## 💎 $GEMSEARCH, the token

| | |
| --- | --- |
| **Chain** | Solana (Token-2022), launched on pump.fun, graduated to PumpSwap |
| **Contract** | `GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump` |
| **Buy** | [pump.fun](https://pump.fun/coin/GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump) · [DexScreener](https://dexscreener.com/solana/GQCGitfVw5LYnj4L4zrNUMYeK9dNxEJi9ZjMwMfQpump) |
| **Burned** | Live on [gemsearch.fun/burn](https://gemsearch.fun/burn): every burn is on chain with its transaction (about 5% of the supply so far) |
| **Buyback** | 2 SOL of $GEMSEARCH bought back from creator fees ([transaction](https://solscan.io/tx/2Xikg61Ab49jsmKSdHQYDfYfpNAXTzmTAUnSDMRr36qM87pg3FjCsms37sRuBZP6rSCbk62izeUjaJ7auMkB73wQ)) |

Every tool below is free and does not require holding the token. Burning reduces supply; it is not a promise of price. Nothing here is financial advice.

## 🕸️ The spider on the web: tools at gemsearch.fun

Everything below is free, needs no wallet connection and runs on the open-source server in [`launchpad/`](https://github.com/h100envy/gem-search/tree/launchpad/launchpad).

| Tool | What it does |
| --- | --- |
| **[Scanner](https://gemsearch.fun/scan)** | Paste any Solana contract address: mint and freeze authority, top 10 holders, the dev's share and earlier pump.fun launches, liquidity or curve progress, Dex profile, ticker clones. A score out of 100 with every reason; red flags first, and anything it could not read is *unknown*, never *safe*. Shareable card |
| **Web X-ray** | Under every scan: a web of who really holds the coin. Wallets that bought in the launch block with the dev, wallets funded from one source, coins passed between holders. Verdict BUNDLE / LINKED WALLETS / NO LINKED WALLETS; every link opens its transaction |
| **Bundle Crew** | The spider's memory across launches. Every pump.fun launch with buys in its launch block is recorded with who bought, who funded them and what the coin did an hour and a day later. When the same funders show up in a new coin, the scan shows that crew's earlier launches and how they ended. Memory started on October 7, 2026 |
| **Grok Council** | Under every scan: four Grok seats debate the coin. The Lookout searches X live; the Skeptic, the Builder and Timing argue from the spider's on-chain facts; all four vote APE / WATCH / AVOID, and you can ask the council follow-up questions. X claims are treated as opinions and checked against the data. Also `/council <CA>` in the bot |
| **Clean Launch Feed** | `/feed on` in the bot: every pump.fun launch is checked about 30 seconds after mint, and the ones that pass your filters land in the chat: buys in the launch block, dev buy size, links, how many coins the dev launched in 24 hours, crew memory. Tune with `/feed set dev=3 block=0 links=2`. Clean is not the same as good: it removes the obvious traps |
| **[Council record](https://gemsearch.fun/record)** | Every council verdict is stored with the coin's market cap and checked 24 hours later: AVOID right if it fell 30%+, APE if it rose 30%+, WATCH if it moved less. Public accuracy by verdict and by seat, best and worst calls, nothing hand-picked |
| **Council sentinel** | In the bot, when an account you `/track` drops a contract address, the council convenes by itself and posts the Skeptic's take and the verdict under the post (a few times a day per chat). In groups, reply to a message with an address with `@gemsearchfunbot council`, `roast` or `xray` |
| **The Roaster** | Grok in fun mode roasts a coin from its on-chain facts (🔥 Roast it under the scan, `/roast <CA>` in the bot) or your whole bag on [gemsearch.fun/me](https://gemsearch.fun/me). Jokes about the numbers, never about people |
| **[Am I exit liquidity?](https://gemsearch.fun/me)** | Paste your own wallet: every memecoin in it is scanned and the largest positions X-rayed. One verdict weighted by position size, with a shareable card. Public balances only |
| **[Bundle Index](https://gemsearch.fun/live)** | Live: every new pump.fun launch, 30 seconds after mint, checked for other buys in its launch block. 3+ = bundled, 1–2 = sniped, 0 = clean. Live feed, share of the day, biggest launch blocks, hourly chart, dev-buy sizes |
| **[Spider's chain pick](https://gemsearch.fun/launch)** | On the launch page: which chain to launch on right now, Solana (pump.fun) or Robinhood Chain (pons). Compares the last 24h of launches (the crowd you compete with) and the share that reached a DEX (pons factory events on chain; a DexScreener sample for pump.fun). The pick follows the numbers; Grok adds the mood on X for each chain. One click switches the form |
| **[Burn](https://gemsearch.fun/burn)** | Burn $GEMSEARCH from your own wallet in one click: a Token-2022 BurnChecked built in the browser, signed by you. Live total burned, % of supply, every burn with its transaction, and the countdown to the next scheduled burn |
| **[Launch Cup](https://gemsearch.fun/cup)** | Every week the three most successful coins launched through gemsearch.fun win $50, $20 and $10: ranked by market cap at the end of the week, one coin per creator, bundled launches out. Live table |
| **[Telegram bot](https://t.me/gemsearchfunbot)** | `@gemsearchfunbot`: send a contract address for the scan card, `/xray` for the web with its crew line, `/watch` for before → after alerts when the dev sells, liquidity drains or the coin graduates, `/track @account` to follow up to 5 X accounts: their new posts land in the chat, with a scan button when they drop a contract address. Also `/council`, `/roast`, `/feed`, `/cup` and `/launch`. Works in groups |

A crew, a cluster or a bundle is a funding pattern on chain, not a proven identity. A high score means a clean launch, not that a coin will go up.

## 🚀 Launch a coin from gemsearch.fun

The spider finds the narrative. Now you can launch on it without leaving the site: **[gemsearch.fun/launch](https://gemsearch.fun/launch)** creates a coin on **Solana via pump.fun** or on **Robinhood Chain via pons**, from the wallet in your browser. Not sure which? The spider's chain pick at the top of the page compares both chains right now. Coins launched here also enter the weekly [Launch Cup](https://gemsearch.fun/cup).

| | |
| --- | --- |
| **Everything pump.fun asks for** | Image, name, ticker, description, website, X and Telegram |
| **Dev buy** | Your first buy in the same transaction, up to 5 SOL, before snipers get the cheapest part of the curve |
| **Creator fees to a GitHub dev** | Send 1 to 100% of creator fees to any GitHub account, the rest stays yours. The split is pump.fun's own fee sharing, set inside the launch transaction; the developer claims in the pump.fun app by signing in with GitHub |
| **Pay Dex** | After launch, one button opens DexScreener's own profile order with your coin filled in; you pay DexScreener directly, Gem Search never handles that payment. The page also shows whether any coin's Dex profile is paid |
| **Robinhood Chain via pons** | Switch the network to launch on pons V2 from an EVM wallet (Rabby, MetaMask): the same form, a creator tax of 0–5% paid to your wallet, an ETH dev buy quoted by simulation. The logo is pinned to IPFS and the transaction is built from pons' verified contracts; your wallet sends it |
| **GitHub repo and source post** | Link the repo behind a coin and the X post it was made about. Neither launchpad has fields for them, so they go in the X and website fields when free, otherwise at the end of the description, and show as badges in our list |
| **0% to Gem Search** | No platform fee, no cut of creator fees |

**How it stays safe.** The coin's mint key is made in your browser and never leaves it. The launch server stores the image and metadata on IPFS, builds the pump.fun transaction with you as payer and owner, and sends it only if what your wallet signed is byte for byte what it built. It holds no key of yours and keeps no accounts. The server is open source in [`launchpad/`](https://github.com/h100envy/gem-search/tree/launchpad/launchpad) on the `launchpad` branch, with tests and a mainnet simulation that spends nothing.

Coins follow pump.fun's and pons' rules and fees. Gem Search does not review, endorse or list what anyone launches.

## ✨ What's new: the spider catches it early

<p align="center"><img src="docs/whats-new.svg" alt="Emerging signals: cashtags, Solana addresses, emerging phrases and growth" width="100%"></p>

<!-- 🎬 Screen recording: drag the .mp4 into GitHub's README editor and keep the generated link on its own line here. -->

A narrative is most interesting **before it has a name**. Until now the spider sorted everything into five fixed topics. Now it also notices the small, specific things that show up first, and tells you how fast they are moving.

<table>
<tr>
<td width="50%" valign="top"><h3>💲 Tickers</h3>Every <code>$CASHTAG</code> in your captures becomes its own lead, with its own authors and posts. <code>$BTC</code>, <code>$SOL</code>, <code>$USDC</code>, other majors and prices like <code>$100</code> are skipped. One click opens a live X search.</td>
<td width="50%" valign="top"><h3>🧾 Contracts</h3>Solana addresses are kept only when they decode to a real 32-byte key, so long random words never sneak in. One click opens the address on Solscan.</td>
</tr>
<tr>
<td width="50%" valign="top"><h3>🌱 New narratives</h3>Two-word phrases that <b>three or more different authors</b> repeated in the last 6 hours, outside every known topic. Overlapping wording from one sentence counts once.</td>
<td width="50%" valign="top"><h3>📈 Growth</h3>Each lead shows mentions in the last 6h against the pace of the 18h before, authors in the last 6h, and when the spider first saw it. Quiet for a day, then everyone at once: that is the ×9.</td>
</tr>
</table>

**In Discovery:** filter by signal type, sort by **Fastest growing**, **Newest first** or **Most authors**, and open the velocity panel on any lead.

### Try it in one minute

```sh
python3 app.py                       # terminal 1: the local engine
python3 scripts/spider_demo.py       # terminal 2: stream fictional sample posts with live logs
```

The walkthrough sends each post through the extension API and prints what the real engine reports back: captures, engine events, every lead with its growth and four checks. Use `scripts/sample_signals.py` instead for a silent load, or `--speed 2` for a faster run.

1. Open **http://127.0.0.1:8787**, wait ~10 seconds for the spider loop.
2. In **Discovery**, switch **All types** to **Tickers $**, then **New narratives**.
3. Set the sort to **Fastest growing**: `$WEBZ` and “rainbow spiders” jump to the top at ×9.
4. Open a lead to see the **Signal velocity** panel, the posts behind it and the Solscan / X search link.

The sample posts, handles, `$WEBZ` and the address are invented and marked `(sample)`. On a real feed the same leads appear from what the spider sees in your tabs.

### Bring your own topics

Copy `topics.example.json` to `topics.json`, edit the patterns (up to 40 topics, case-insensitive regular expressions) and restart. A broken file is ignored with a warning and the built-in topics stay active. `topics.json` stays on your machine.

### Same rules as before

- **Research-only.** Tickers, addresses and phrases never enter the launch queue, even with `SPIDER_ALLOW_LAUNCH=1`. They belong to other people.
- **Local.** Detection runs inside the engine on your computer. No new API calls, no new keys.
- **Bounded.** Up to 10 tickers, 10 addresses and 5 phrases per pass, strongest first, so the Grok allowance goes to the best leads.
- **Honest.** Growth describes your browsing sample, not all of X. Three coordinated accounts can fake a phrase; a cashtag is a lead, not a verified token.

## Meet your narrative spider

Gem Search puts an animated eight-legged research companion on your X feed. It walks between visible posts, highlights what it is inspecting, and sends a small capture to a research engine running on your computer.

**JEV** groups recurring topics and project links. **Crawler** reads public sites, repositories and docs. **Four Grok seats** challenge the evidence from different perspectives. Your dashboard keeps the sources, gaps and decisions together.

The spider is a browser overlay, not an operating-system desktop pet. It cannot walk outside the page or monitor another application. It doesn't like, reply, follow accounts or connect a wallet.

This is an open-source developer preview, not a promise of early alpha. A shortlist is a research lead, not proof of safety, originality or future returns.

<p align="center"><img src="docs/field-guide.svg" alt="Four features: visible-post spider, source evidence, offline queue and local rules" width="100%"></p>

## What it does

| Layer | Behavior |
| --- | --- |
| 🕷 Spider | Animated overlay, current-post highlight, capture counters, pause/dismiss, optional visible-tab auto-scroll |
| JEV | Local post deduplication, topic grouping, cashtags, Solana addresses, emerging phrases, 6h growth, author diversity and repeated-text checks; editable English/Russian topics |
| Crawler | Follows bounded public HTTP(S) links; caches pages for 30 minutes; blocks private-network targets |
| Grok seats | Four actual API requests with role-specific prompts, structured output and evidence references; optional |
| Dashboard | Filterable projects/narratives, local checks, Grok reasons, sources, persistent activity log and JSON export |
| Local queue | Survives extension worker suspension and backend restarts; bounded to avoid unlimited collection |
| Economy mode | No paid X API required to inspect the posts already visible in your browser; local rules work without Grok |

**JEV is our own signal detector**, not an integration with an unnamed external JEV product. Grok uses the official xAI API; this repository is not an official X/xAI extension. Reading the current DOM is not an X firehose or a substitute for a licensed data service.

## ✦ Turn a finding into a keepsake

Open a project in **Discovery**, click **Discovery capsule**, choose **Aurora** or **Daylight**, and download a standalone SVG card. It captures mentions, observed authors, local check results, Grok status, up to three source addresses and a UTC timestamp. A rainbow spider signs the design.

- Preview before downloading; the selected finding is frozen while the card is open.
- Generated entirely in your browser, without an API call or automatic posting.
- Demo findings remain visibly marked. Missing evidence stays missing.
- Source addresses omit credentials, query strings and fragments; review the visible content before sharing.

## Pick your first adventure

<p align="center"><img src="docs/research-modes.svg" alt="Three research modes: fictional playground, local feed scout and optional paid Grok review" width="100%"></p>

- **🎨 Just look around:** launch the backend and open `/spider-demo` to meet the spider on fictional posts.
- **🕷️ Explore your feed:** pair the extension, open X and release the spider on the active tab.
- **🧠 Ask more questions:** add your own xAI key to enable the four Grok reviewers.
- **📂 Bring existing research:** import JSON captures using the documented [data format](docs/DATA_FORMAT.md).
- **🌱 Broaden the inputs:** run `python3 app.py --autopilot` for the Hacker News scanner and inbox watcher.

## Quick start

Python **3.11+**, Chrome/Chromium. Backend: macOS, Linux, or Windows through WSL2. Node **22+** is needed only for the full test suite and optional Solana module; the research backend and extension need no npm build.

```sh
git clone https://github.com/h100envy/gem-search.git
cd gem-search
cp .env.example .env
python3 app.py
```

1. Open **http://127.0.0.1:8787**. Visit **Connections** and copy the local pairing code.
2. Open **chrome://extensions**, enable **Developer mode**, click **Load unpacked**, select this repository's **extension/** directory.
3. Open the Gem Search toolbar popup, paste the pairing code and click **Connect**.
4. Open an X feed, search or profile page. Choose **Until I stop it** (the default) or a time limit, then click **Release spider on this tab**.
5. Scroll normally, or opt into auto-scroll, including in the background. The spider samples rendered posts in the selected feed's viewport even when you switch tabs or apps. Editing on the visible page pauses auto-scroll, not the scanner. **Stop scanner** in the popup works from any tab; overlay Stop or dismiss also ends the session.

The local engine must stay running. If it is offline, up to 200 captured posts remain in the extension queue. The next successful connection forwards them. Worker suspension and same-origin feed reloads retain the scanner's original session/deadline. A one-minute worker alarm supplements content timers in background tabs. Captures after the deadline are rejected even if an alarm is delayed.

Keep the browser and selected feed tab open. Browsers can throttle background execution; sleeping computers and discarded/frozen pages cannot render new posts. The session waits for an unloaded tab to recover. Closing that tab, leaving supported feed routes/origin, or restarting the browser ends the session. Start a new session after reopening the browser. Stop prevents new collection; already queued posts may still be forwarded. This is best-effort background research, not an always-on data feed.

**Try the spider without an X account:** open **http://127.0.0.1:8787/spider-demo**. It uses the same spider renderer over fictional cards, makes no API calls and collects nothing. The dashboard's **Demo scan** separately exercises the research pipeline with clearly marked synthetic projects.

## Give it four Grok perspectives

<p align="center"><img src="docs/grok-seats.svg" alt="Lookout, Maker, Skeptic and Runner - four evidence-bound Grok reviewers" width="100%"></p>

Add your key **locally** to `.env`, then restart the engine:

```dotenv
GROK_ENABLED=1
XAI_API_KEY=your_local_api_key
GROK_MODEL=grok-4.7
GROK_DAILY_CALLS=12
```

| Seat | Question |
| --- | --- |
| **Lookout** | Is there a noteworthy signal in the observed sample? |
| **Maker** | What product or technical evidence is actually present? |
| **Skeptic** | What is contradictory, risky or still unverified? |
| **Runner** | Is there enough evidence to investigate this now? |

Reviews begin only after at least four distinct observed authors. One full review makes **four requests**, so the default limit permits at most **three full reviews per rolling 24 hours**, including failed calls. Results are cached for 24 hours for identical evidence/model inputs. Each request has bounded excerpts and a 700-token output limit. This is a request allowance, **not a guaranteed dollar cap**; your xAI plan determines charges. No xAI search tools are enabled.

Keys stay in the backend. Collected excerpts leave your computer **only when Grok is enabled**, sent to `api.x.ai` for analysis. Without a key, the UI shows local checks instead. An unavailable model, exhausted allowance, invalid response or invented citation cannot count as a pass. Model outputs cannot execute code, browse independently or control wallets.

The Grok adapter is implemented and covered by mocked tests. A real paid Grok call has **not** been validated in this checkout because no xAI key was provided.

## Follow a discovery

<p align="center"><img src="docs/discovery-trail.svg" alt="Discovery pipeline: spot visible posts, group topics, explore links, question evidence and revisit findings" width="100%"></p>

1. **Spot a recurring idea.** The spider captures rendered posts as you explore a visible X tab.
2. **Connect the mentions.** JEV groups supported topics and project links, deduplicates captures and checks author diversity.
3. **Read beyond the post.** The crawler retrieves bounded public pages to add context to the observed signal.
4. **Challenge the story.** Local checks run first; optional Grok seats return separate reasons tied to supplied evidence.
5. **Keep the trail.** Open the dashboard to review sources, inspect unknowns and export findings as JSON.

*These illustrations explain the workflow; they are not screenshots or measured results.*

## Your first research session

- [ ] Start the local engine and open the dashboard.
- [ ] Try the fictional spider demo before connecting a real feed.
- [ ] Pair the extension from **Connections**.
- [ ] Release the spider on an X feed, search or profile page.
- [ ] Watch the capture counter; pause whenever you want.
- [ ] Open a finding and read its linked sources.
- [ ] Compare the available checks and explicitly unverified claims.
- [ ] Export useful findings for your own follow-up research.

## Keep the running cost small

- **Begin without Grok.** Local grouping and checks do not require an xAI key.
- **Reuse crawled pages.** The crawler caches pages for 30 minutes.
- **Reuse model reviews.** Identical evidence/model inputs use a 24-hour review cache.
- **Bound the model workload.** The default allowance is 12 requests per rolling 24 hours; each full review uses four.
- **Choose when to collect.** Capture runs on the visible tab; auto-scroll is optional.

Your computer, internet connection and any enabled paid services still have their own costs. Request limits do not guarantee a fixed API bill.

## A transparent pipeline

```mermaid
flowchart LR
    X[Visible X posts] --> S[Spider overlay]
    S --> Q[Extension queue]
    Q --> L[Paired localhost API]
    L --> J[JEV signal detector]
    J --> C[Cached crawler]
    C --> R[Local evidence checks]
    R --> G[Optional Grok seats]
    G --> D[Dashboard and shortlist]
    R --> D
```

A browser token can only submit captures and read scanner status. It cannot launch tokens. The extension has no account-action code and no xAI API key. See [architecture](docs/ARCHITECTURE.md) and [privacy](docs/PRIVACY.md).

## Connect your launch platform

- **Built-in:** Pump.fun via the existing local PumpPortal executor.
- **Bring your own:** connect a Solana platform through the new HTTPS launch-bridge protocol.
- **Keep one queue:** provider selection preserves the five-attempt daily quota and narrative deduplication.
- **Recover conservatively:** jobs pin their provider; uncertain submissions are polled without creating a replacement.
- **Build an adapter:** a Python HTTPS + SQLite scaffold is included. Map its two hooks to your platform API.

Select `LAUNCH_PROVIDER=pumpportal` or `bridge` in `.env`. An arbitrary platform website URL does not work: it needs a compatible adapter. External bridges manage their own signing and must enforce the requested 0.025 SOL cap; their results are reported, not independently verified by Gem Search. Other chains are not supported by the current SOL budget policy.

**[Connection guide and API contract →](docs/LAUNCH_PROVIDERS.md)**

## Other sources and optional launch module

- JSON import and `data/inbox/` support external collectors. See [data format](docs/DATA_FORMAT.md).
- `python3 app.py --autopilot` also enables the free Hacker News narrative scanner and inbox watcher. HN attention is labeled separately from X captures.
- Official X recent-search access remains optional and paid; `ENABLE_PAID_X=0` by default.
- The earlier experimental Pump.fun launcher remains available as a **separate opt-in module**, dry-run by default. Browser captures cannot enter it without `SPIDER_ALLOW_LAUNCH=1`.
- Its configured ceilings are 0.025 SOL per attempt and five attempts per rolling 24 hours. It is not required to use the spider. See [launch module](docs/AUTOLAUNCH.md) and [setup](SETUP.md).

## Package, test, contribute

```sh
npm ci --ignore-scripts
python3 -m unittest discover -s tests -v
npm test
python3 scripts/package_extension.py
```

The ZIP is written to `dist/gem-search-extension.zip`; it contains extension assets only. Extract it and load that directory as an unpacked extension. GitHub Actions also uploads the ZIP as a build artifact. This is **not** a Chrome Web Store listing.

Tests cover capture validation, route exclusions, deduplication, narratives, Grok caching/allowances/failures, local-network blocking, queue recovery, and optional transaction guards. They do not establish that every future X layout will work. Full browser installation and real-account capture still need manual QA against the current X markup. See [contributing](CONTRIBUTING.md).

## Project map

```text
extension/           Manifest V3 popup, worker, extractor and animated spider
jev.py               Local topics, tickers, addresses, emerging phrases, growth
topics.example.json  Template for your own local topic list
grok.py              Four optional API reviewers + persistent request allowance
app.py               Local HTTP engine, crawler, dashboard and capture worker
static/              Research dashboard
docs/                Architecture, privacy, preview and launch documentation
scripts/             Icon generation, ZIP packaging, sample signals and terminal walkthrough
automation.py        Optional durable launch queue
launch/              Optional isolated-wallet Solana executor
launchpad/           gemsearch.fun server (launchpad branch): pump.fun and pons launches, scanner, X-ray,
                     council, bundle index, burn, Launch Cup, chain advisor and the Telegram bot
tests/               Offline tests and unsigned provider fixture
```

## Limits worth understanding

X markup changes. The extractor uses rendered `article[data-testid="tweet"]`, text, timestamp permalinks and visible external anchors. Shortened `t.co` links aren't treated as verified project sites. Topic discovery uses a small, inspectable taxonomy that you can replace with `topics.json`. Emerging-phrase detection catches repeated wording, not meaning: it can miss memes spelled differently, sarcasm and novel projects, and three coordinated accounts can fake a phrase. A cashtag or address is a lead, not a verified token. A linked repository isn't proof of a functioning product. No model here detects every scam or bot ring.

The engine is local and single-user. Do not expose its port to the internet. Keys, wallet files, captured posts and SQLite are ignored by Git. Read [SECURITY.md](SECURITY.md) before changing trust boundaries.

MIT · Independent project. Not affiliated with X, xAI, Pump.fun, PumpPortal, pons, Robinhood or DexScreener.

<br>
<p align="center">🌸 🟠 🌼 🌿 🧊 🔮</p>
<p align="center"><b>Keep the curiosity. Keep the receipts.</b><br><sub>If this little spider belongs in your feed, give it a star and help it grow.</sub></p>
