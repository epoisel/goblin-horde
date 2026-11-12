# Goblin Horde: idle + battle game design

Status: draft v0.2 · Branch `goblin-pets` (from `horde-window`) · Windows + T3 first · Supersedes the economy in `goblin-pet-spec.md`

**Marks:** *(decided)* came from the owner. *(proposed)* is my recommendation and open to change. Numbers marked *(tune)* are starting points from one person's 10 days of T3 data, not final balance.

## 1. Premise

Using AI is the income. Every agent turn that finishes pays coins. Coins build a horde of goblins and buy upgrades. The active loop is battles where the **whole horde** fights one big boss (hundreds of goblins against an ogre) to see how far it gets. The name is Goblin Horde, not Goblin Party, so scale is the point.

## 2. Host and data source: T3 *(decided)*

T3 is a requirement for the first edition; Orca is dropped. Separate editions later, each with its own source adapter (*proposed*: shared core plus `hosts/t3`; a Claude-hooks edition can return later from git history).

The T3 adapter reads `~/.t3/userdata/statev2.sqlite` **read-only** (Node 22.13+, `node:sqlite`). It selects only ids, status, provider, token counts and timestamps. It never reads `payload_json` text fields, message text, or titles. Nothing about prompts, commands, or files is stored. The T3 edition installs no Claude Code hook.

Tables used: `orchestration_v2_projection_provider_turns` (turn status, `turnTokenUsage`), `..._runs`, `..._subagents`, `..._turn_items` (item types and statuses). The raw `orchestration_v2_events` table is compacted away, so a persisted timestamp watermark plus a recent-id set replaces an event cursor. First launch starts from "now": nothing that finished before launch pays, even minutes before. Work finished while the app was closed is replayed on the next launch under the normal rules, up to `idle.catchUpDays` (7) back, and the small idle trickle is paid once on top. The adapter checks that the tables and columns exist and fails closed with a plain message, because T3's schema is internal and unversioned.

## 3. Income

### Work income *(proposed, tune)*

Paid when a turn completes (status `completed`; failed, cancelled and interrupted turns pay 0). Every concurrent agent is its own stream, with no special mechanism.

```
W     = fresh_input + 5 * output          # fresh_input = inputTokens - cachedInputTokens
coins = max(2, 1.6 * sqrt(W / 1000))
```

- Cache reads are excluded. About 97% of raw input is context re-read per tool call, so raw tokens measure context size times tool calls, not work.
- Concave, so 100x the tokens pays about 10x the coins. A 100M-token burn pays about 500 coins. This keeps wasting tokens from being worth it.
- The floor of 2 stops one-word-prompt farming.
- Turns with partial or missing usage (about 4% of turns) pay the floor.
- Subagent completions pay a flat 4 coins. T3 reports usage for the main agent only.
- No daily cap *(decided)*. Every finished turn pays in full all day, so 20 agents are 20 full streams. The square root above is the only brake on income. Section 11 shows what each kind of user earns a day.

Replay on the owner's 10 days: heavy days 610–770 coins, light days 25–50, about 2,700 total.

### Idle trickle *(proposed, tune)*

0.1 coin/min per 100 goblins, capped at 4 hours banked, shown once as "while you were away". It must stay far below a light day (25–50 coins) so AI use remains the income.

## 4. The horde

### How goblins are gained *(proposed)*

- **Recruit:** spend coins to recruit a basic Grunt. The cost is `round(40 * 1.01 ** (size - 3))`, and a new player starts with 25 coins so the first recruit is about 2 turns away.
- **Class promotion:** at class level 5 a Grunt group is promoted into a class the player picks. Classes unlock two ways, both deterministic with no gacha:
  - **Boss spawn:** a boss's first clear spawns a specific class ("this scenario spawns this goblin").
  - **Work mix:** T3 item *types* only. `web_search` unlocks Scout, `file_change` Smith, `command_execution` Sapper, long reasoning Shaman, `subagent` Chieftain.

### Progression is per class, not per goblin *(proposed)*

With hundreds of goblins, per-goblin levels and gear are unmanageable. Each class has one level, one XP pool, and one gear tier, and they apply to every goblin of that class. An individual goblin is only an id, class, palette and optional name. Stored as class counts plus a short list of named heroes, so `pets.json` stays small at thousands.

### Upgrades *(proposed, tune)*

Costs grow about 1.4–1.5x per level, benefits linearly. Total income multiplier capped around 3x.

| Upgrade | Effect |
|---|---|
| Hoard | + coin multiplier |
| Training | + XP multiplier |
| Class gear | class-specific damage/health tiers |

## 5. Battles *(decided unless marked)*

- **Never blocked.** No energy, stamina or sortie limits. Start a battle any time.
- **Whole horde fights.** One big boss per battle. Resolved as an aggregate simulation (class counts x level x gear against boss HP, phases and weaknesses), not per-goblin physics. Levers: horde size, class mix, gear, which boss to challenge. Bosses can be weak to certain classes. A battle runs 30–60 s.
- **Rewards per battle.** First clear pays the most; reruns pay less.
- **Death costs nothing.** A lost battle gives no reward and loses nothing.
- **Whole team gets XP**, class by class.
- **Class-specific gear** drops from bosses.
- **Rerun guard** *(decided)*: unblocked reruns could replace AI income, so a first clear always pays 100%, and each rerun of that boss pays 25%, then 10%, then 3% of it for the rest of the day, resetting daily. Coins, scrap and XP all take the same share. A won fight never pays nothing: it pays at least 1 coin, 1 scrap and 1 XP. A lost fight pays nothing. First clears also pay the gear and class spawn. Battle scrap is a separate currency for gear. First clears are gated by horde power, which AI coins buy. Section 11 says how far this guard still holds for someone who only battles.
- Reward magnitudes *(tune)*: set by simulation so a boss's first clear is worth roughly a few typical days of horde growth, not hours.

## 6. Rendering budget

Benchmarked: Tk canvas, keyed-colour transparent topmost window (the existing technique), pre-rendered `PhotoImage` sprites, all goblins moving every frame at a 30 fps target.

| Goblins | 16 px: frame ms (achieved fps) | 32 px: frame ms (achieved fps) |
|---|---|---|
| 100 | 7.2 (30) | 6.9 (30) |
| 200 | 12.9 (30) | 13.0 (30) |
| 400 | 25.2 (30) | 25.7 (30) |
| 800 | 49.3 (20) | 49.8 (20) |

- Cost is **per canvas item, not per pixel** (about 0.06 ms per goblin). Shrinking goblins does not help rendering, only count and update rate do. Smaller goblins still help screen space.
- Process CPU stayed low (3–13% of a core): the time is blocked waiting on the layered window, on the UI thread. Network polling must stay off the draw thread.
- **Plan:** simulate the whole horde as math (thousands is fine) and draw a representative crowd, capped at about 200 animated sprites at 30 fps (`maxOnScreen` in `game_config.json`). Beyond the cap, one sprite stands for N goblins with a count badge, or only a subset animates each tick. Re-benchmark with real sprites, a boss, and effects. If thousands must animate, revisit Phase 4 (Tauri, Electron or WebView).
- Caveats: one machine, synthetic sprites, no boss or particles.

## 7. Privacy

Stored in the state folder: counts, class levels, wallet, watermark, daily counters. Never stored: prompt text, commands, todo text, file names, message text. The legacy Claude hook log is purged on first run if present.

## 8. Build order

1. Fix strip placement bug (#9) with a synthetic L-shaped monitor test.
2. T3 adapter (read-only, schema-checked, watermark) with fixture database tests.
3. `game_config.json` plus pure `rewards.mjs`: coins, offline, upgrades. Unit tests.
4. `pets.json` store: atomic write, `.bak`, retry on rename.
5. Horde simulator script to tune rewards and boss HP before UI.
6. Strip UI: coin counter, pop-ups, horde count, class panel.
7. Battle sim and arena renderer under the on-screen cap.
8. Strip the old monitor and phone code from the T3 edition.

## 9. Open questions

1. Promotion at class level 5, or pick the class when recruiting?
2. Should AI work give a small passive XP share to every class, or should XP come only from battles?
3. What is the minimum PC the on-screen cap should target?

## 10. Economy model and simulator contract

The first simulator covers the economy spine with the horde as one unit. Classes are layered on after the pacing feels right.

### Data shape

One immutable state value, changed only by pure reducers in `lib/rewards.mjs`. Every constant lives in `game_config.json` (`schema` 1).

```
GameState = {
  schema: 1,
  wallet:   { coins, scrap, lifetimeCoins },
  horde:    { size, level, xp, gear },            // gear is a tier
  upgrades: { hoard, training },                  // levels
  bosses:   { cleared },                          // boss i may be first-cleared only when i === cleared
  today:    { key, reruns: { [bossIndex]: count } }
}
```

A save written before the daily cap was removed also holds `upgrades.vault` and `today.coinsEarned`. It still loads. Those two fields are dropped when it is read and are not written again, to `pets.json` or to its backup. Coins spent on vault levels are not refunded.

### Rules

- **Work income:** section 3. `hoard` multiplies coins by `1 + hoardBonus * level`. Work also pays `xpPerCoin * coins * (1 + trainingBonus * level)` horde XP.
- **No cap:** work income has no daily limit. `today` keeps only the day's date and its rerun counts.
- **Power:** `size * (1 + powerPerLevel * (level - 1)) * (1 + powerPerGear * gear)`.
- **Boss i** needs `powerBase * (i + 1) ** powerExponent`, a power law because the horde's power rises fast early and flattens later, so an exponential ladder is cleared in week one and then stalls. A fight wins when `power * (1 + variance * (luck - 0.5)) >= required`, with `luck` injected in [0, 1) so tests and the sim stay deterministic.
- **First clear** of boss `cleared` pays full coins, scrap and XP, and advances `cleared`. **Reruns** of any cleared boss pay `rerunDecay[min(n, last)]` of the first-clear coins, scrap and XP, where `n` is that boss's reruns today (the first rerun is `n = 0`). Each of the three is rounded and then raised to at least 1, so a win always pays something. A loss pays and changes nothing, and does not count as a rerun.
- **Level up** needs `xp >= xpToNext(level)` and `levelCoinCost(level)` coins. It spends the coins, subtracts the XP, and keeps the remainder.
- **Purchases** never take the wallet below zero. Recruit cost is `recruitBaseCost * recruitGrowth ** (size - startSize)`.

### Feel targets the simulator checks

The first set was written before tuning. After the first run showed that lower-bound-only targets cannot detect "too fast" or "battles pay too much", I added upper bounds and `battleCoinShare` (AI use must stay the income). Targets live in `scripts/sim/feel-targets.json`. One was loosened after seeing data: heavy 200 goblins moved from "within 30 days" to 35, because its real spread across seeds is 26 to 31 days and the 30 was a guess, not a rule.

- First purchase within 3 completed turns. First boss clear on active day 1.
- A typical user makes at least 2 purchases on a median active day in the first 14 days, and never goes more than 2 active days in a row with no purchase and no first clear in the first 30 days.
- Typical: horde at least 12 on day 7, at least 60 on day 30, 200 between day 45 and 90.
- Heavy: 200 within 30 days, but the 30-boss ladder is not finished before day 60.
- Light: still progresses (horde at least 20 on day 30), no stall over 4 active days.
- Fleet (20 concurrent streams): every stream pays in full, and the ladder still takes at least 45 days.
- Farmer (no AI work, 100 battles a day): coins per day at day 30 at most 75% of the typical user's work income, and horde at day 30, 60 and 90 at most 70%, 75% and 85% of the typical user's. These were 25% and half until reruns paid real coins. Section 11 says why.

## 11. Tuning results (simulated)

Run `node scripts/sim/horde-sim.mjs --persona all --check` for one seed, or sweep seeds with `--seed N`. Config values live in `game_config.json`.

With the daily cap removed and reruns paying coins, 23 of the 27 targets hold on every one of seeds 1 to 20. The four farmer targets failed on every seed at their old limits. The owner chose to move them (the farmer limits above), and all 27 targets now hold on seeds 1 to 20. "The farmer check" below gives the numbers and the choice that was not taken.

Each number is the median of seeds 1 to 20. The owner row is one replay.

| Persona (90 days) | Horde day 7 | Horde day 30 | 200 goblins | Bosses day 30 | Ladder of 36 |
|---|---|---|---|---|---|
| Light (6 turns, 4 days a week) | 8 | 38 | not in 90 | 4 | not in 90 |
| Typical (25 turns, 5 days a week) | 42 | 133 | day 65 | 11 | not in 90 |
| Heavy (45 turns, daily) | 89 | 208 | day 28 | 17 | not in 90 |
| Fleet (400 turns, daily) | 271 | 433 | day 4 | 31 | day 62 |
| Owner (your real T3 days, looped) | 57 | 146 | day 57 | 12 | not in 90 |
| Farmer (no AI work, 100 battles a day) | 21 | 77 | not in 90 | 10 | not in 90 |

### Coins a day

Coins from every source (work, battles, idle), averaged over the week that ends on that day. The simulator prints them as `coinsPerDayDay7`, `30`, `60` and `90`. Median of seeds 1 to 20, with the lowest and highest seed in brackets.

| Persona | Day 7 | Day 30 | Day 60 | Day 90 | Share from battles |
|---|---|---|---|---|---|
| Light | 65 (33 to 100) | 71 (47 to 104) | 88 (65 to 124) | 97 (68 to 132) | 6% |
| Typical | 352 (268 to 430) | 456 (300 to 565) | 469 (384 to 565) | 473 (386 to 622) | 5% |
| Heavy | 938 (719 to 1,132) | 1,104 (970 to 1,284) | 1,148 (892 to 1,611) | 1,296 (958 to 1,435) | 6% |
| Fleet | 8,384 (7,468 to 10,028) | 11,497 (8,583 to 13,608) | 12,195 (10,478 to 14,024) | 13,348 (11,498 to 14,653) | 1% |
| Owner | 508 | 650 | 863 | 867 | 5% |
| Farmer | 127 (124 to 128) | 182 (170 to 186) | 240 (228 to 248) | 292 (282 to 299) | 89% |

Under the cap the fleet earned 2,877 coins a day in week one and 5,178 by day 90, and it hit the cap on every day. It now earns 2.9 times that in week one and 2.6 times at day 90. The heavy user earned 889 and 1,261 and hit the cap on 1 to 3 days, so removing the cap changes little for one heavy user. Income still grows over time because the Hoard upgrade multiplies it.

### Boss payouts

Coins, scrap and XP for a first clear and for each rerun of the same boss on one day.

| Boss | Power needed | First clear | Rerun 1 (25%) | Rerun 2 (10%) | Rerun 3 and later (3%) |
|---|---|---|---|---|---|
| 1 | 2.5 | 20, 4, 40 | 5, 1, 10 | 2, 1, 4 | 1, 1, 1 |
| 2 | 10.4 | 21, 5, 46 | 5, 1, 12 | 2, 1, 5 | 1, 1, 1 |
| 3 | 23.8 | 22, 6, 53 | 6, 1, 13 | 2, 1, 5 | 1, 1, 2 |
| 6 | 98.4 | 27, 10, 80 | 7, 2, 20 | 3, 1, 8 | 1, 1, 2 |
| 10 | 280.5 | 34, 21, 141 | 8, 5, 35 | 3, 2, 14 | 1, 1, 4 |
| 21 | 1,283.8 | 64, 153, 655 | 16, 38, 164 | 6, 15, 65 | 2, 5, 20 |
| 36 | 3,875.8 | 154, 2,363, 5,327 | 38, 591, 1,332 | 15, 236, 533 | 5, 71, 160 |

### What changed when the daily cap was removed, and why

1. **No daily cap, no Vault.** `income.dailyCapCoins`, `income.overCapRate` and the Vault upgrade are gone. The Vault's only job was to raise the cap. Buying `vault` is refused.
2. **Reruns pay coins.** Rerun coins were 2% of the rerun share, which rounded to 0 coins for the first 10 bosses. Coins now take the same 25%, 10%, then 3% as scrap and XP, `bosses.rerunCoinFraction` is gone, and a win pays at least 1 coin, 1 scrap and 1 XP.
3. **First-clear coins grow 1.06x a boss, was 1.12x.** At 1.12x, reruns at the full share made battles 9% to 11% of a typical user's income and 18% to 19% of a heavy user's, and a player with the whole ladder cleared could take 3,681 coins a day from three reruns of each boss. At 1.06x that is 905 coins, and battles are 5% to 7% of income for typical, light and heavy users, where they were 3% to 5% before reruns paid coins. The last boss's first clear pays 154 coins, was 1,056. Scrap and XP are unchanged and stay the real battle rewards.
4. **Boss ladder exponent 2.05, was 2.** Without the cap the fleet finished the 36 bosses on day 32 to 36, under the 45-day target. I tried lowering `income.k` first, as the smaller change. At 1.3 the fleet still finished on day 37 to 43. At 1.1 it finished on day 41 to 49, which still failed on one seed, and the heavy user's 200 goblins slipped past day 35 on 17 seeds. So `income.k` stays at 1.6. With exponent 2.05 the last boss needs 3,876 power, was 3,240, and the fleet finishes on day 58 to 65. A typical user clears one boss fewer by day 30 (11, was 12) and by day 60 (15, was 16).
5. **Bot fixes, so the farmer check is honest.** The simulated player valued Hoard and Training by all its income, so the farmer bought upgrades that only raise work income. It now values them by work income. It also reran the newest boss it had beaten even when it could no longer win, and spent every battle on a next boss it had almost no chance against, which made the farmer look weaker than a real one. A loss now costs the rerun it could have won, so the bot takes the fight with the best expected payout, the chance to win times what a win pays today.

### The farmer check

The farmer fights 100 battles a day and never uses AI. Its targets exist to stop battles from replacing AI income. They assumed a rerun paid almost no coins.

| Target | Limit | Now (lowest, median, highest seed) | With every win paying exactly 1 coin |
|---|---|---|---|
| Coins a day at day 30, against a typical user's work income | 0.25 | 0.35, 0.44, 0.69 | 0.21, 0.27, 0.43 |
| Horde at day 30, against a typical user's | 0.5 | 0.55, 0.57, 0.64 | 0.43, 0.45, 0.52 |
| Horde at day 60 | 0.5 | 0.66, 0.68, 0.71 | 0.49, 0.51, 0.53 |
| Horde at day 90 | 0.5 | 0.73, 0.75, 0.79 | 0.54, 0.55, 0.59 |

The last column sets first-clear coins to 1 for every boss, the lowest the coin constants can go. Even then three of the four targets fail on 17 or more of the 20 seeds. One hundred wins a day at 1 coin each is 100 coins, about a quarter of a typical user's work income, so no value of `firstClear.coinsBase`, `firstClear.coinsGrowth` or the `rerunDecay` tail can bring these targets back while every win pays a coin. The farmer does not overtake a typical user. At day 90 it earns 292 coins a day against the typical user's 473, and it has three quarters of the horde.

Two ways to close this, for the owner to choose:

- **Keep "every win pays a coin" and move the targets** to what it gives: coins at day 30 at most 0.75 of a typical user's work income, and horde at most 0.7, 0.75 and 0.85 at day 30, 60 and 90. In plain words, someone who never uses AI and fights 100 battles every day ends up with about three quarters of a typical user's horde.
- **Keep the targets and stop coins after a boss's third rerun of the day.** The first three reruns pay their 25%, 10% and 3% in coins, and later ones pay scrap and XP only. Tried in a scratch copy, all 27 targets hold on all 20 seeds: farmer coins 0.07 to 0.13, horde 0.12 to 0.14, 0.25 to 0.27 and 0.37 to 0.40. This breaks the rule that a won fight always pays a coin, from the fourth rerun of the same boss on.

### What changed from the starting values, and why

Items 1, 2, 3 and 7 were changed again by the round above.

1. **Bot fix.** The simulated player challenged a boss only at 90% power, which luck can never win. It now challenges whenever a lucky swing could win, since a loss costs nothing.
2. **Battle coins cut.** Boss coin payouts grew 1.28x a boss and made battles 50% to 98% of income, with the farmer out-growing a typical user. Now base 20, growth 1.12, reruns 2%. Battles are 3% to 5% of income. Scrap and XP are the real battle rewards.
3. **Rerun rule fixed.** A boss's first win on each new day paid 100% of its first-clear scrap and XP, a daily chore that contradicted "less for reruns". A first clear is now always 100%, and reruns pay 25%, 10%, then 3%.
4. **Recruit curve.** Pure exponential cost front-loaded the horde (117 goblins in week one). Base 40 with growth 1.01 paces it to 40 in week one and 200 at about day 66.
5. **Gear** cost growth 1.6 to 1.8, so gear stays a sink through day 90.
6. **XP made meaningful.** Work XP was 0.5 per coin and left 100,000+ banked. It is now 0.02 per coin, so battles are the XP source.
7. **Boss ladder is a power law**, `2.5 * (n + 1) ** 2`, not an exponential. Exponential power was cleared in week one and then stalled. The 36-boss ladder keeps the fleet user busy to day 82, where 30 bosses ended at day 40 to 44.
8. **Starter pot of 25 coins.** Without it, the first purchase depended on luck and took 4 turns on some seeds.

### Not covered yet

- Classes, class gear and boss weaknesses. The horde is one unit in this model.
- Real play. The bot fights 3 battles a day, a person may fight more or fewer.
- Whether it feels good on screen. Pop-ups, animation and sound are not in a simulator. These numbers set the pacing, and the first real session is the next test.

## 12. Built so far

- `lib/rewards.mjs`, `game_config.json`: pure reducers and every tunable (section 10). There is no daily cap and no Vault, so every finished turn pays in full. A won fight pays at least 1 coin, 1 scrap and 1 XP. A config file that still lists the removed keys stays valid, and they are ignored.
- `lib/t3-source.mjs`: read-only T3 reader. `json_extract` runs inside SQLite so no payload text reaches JavaScript, ids leave only as 16-character hashes, and an unexpected T3 schema fails closed with a plain message. It costs about 0.3 ms per poll on a 250-row history and grows linearly.
- `lib/pets-store.mjs`: `pets.json` saved by temp file and rename, with `pets.json.bak`, retry on Windows file locks, and a shape check that writes only the documented numeric fields. A save from before the cap was removed loads, and its `vault` and `coinsEarned` are not written again, to the save or to the backup.
- `lib/reward-engine.mjs`: the single writer. `start`, `tick`, `snapshot`, `buy`, `fight`, all through one queue. The payment and the watermark save as one record.
- `desktop_platform.rect_is_visible`: the strip must show at least 40 by 20 pixels on a real display or it docks again (fixes the L-shaped monitor case, issue #9).

Verified on the real T3 database: first launch pays nothing for old history, 3 days away catches up 18 turns for 319 coins once, reopening pays nothing more, and the save file holds no text.

- `lib/pets-service.mjs`, `lib/pets-routes.mjs`, wiring in `server.mjs`, and `HordeApi.pets`, `pets_buy`, `pets_fight`: the engine behind the local viewer. The game opens when the viewer holds its port, ticks every second, and answers local requests only (a phone gets 403).
- `desktop_widget.py --surface pets` saves the pet field as the surface when it starts, so a later start with no surface (the Start menu entry) comes back to the game even when it was stopped without **Quit Goblin Horde**.

- `lib/shared.mjs`, `lib/pets-remote.mjs`, `lib/tailscale.mjs`, `lib/shared-manager.mjs`: one game on several computers over Tailscale. The host listens on its Tailscale address for five routes behind layered checks, and a display forwards its local pets routes to the host and opens no saved game. The widget is unchanged. See `docs/SHARED-PETS.md`.

### API for the widget

- `GET /api/pets?after=N` answers `{ready: false, message}` until the game is open, then `{ready: true, boot, seq, events, game, source}`. `game` is `{state, quotes, power, nextBoss}`, `source` is `{ok: true}` or `{ok: false, reason, message}`. `events` are the numbered pop-ups above N: `launch` (new player, away coins, caught-up work) and `work` (coins, xp, turns, subagents per paying tick).
- `boot` names the viewer's run. When it differs from the last one seen, event numbers began again at 1, so ask again from 0.
- `POST /api/pets/buy {kind}` and `POST /api/pets/fight {boss}` need the viewer's Origin. Buy answers `{ok, reason, game}`, fight `{won, ratio, first, rewards, reason, game}`. `kind` is `recruit`, `level`, `gear`, `hoard` or `training`. Any other kind, the removed `vault` included, answers 400.
- Poll at most every 900 ms to keep the 2 second "coins appear" criterion, since the server ticks every 1000 ms.
- `GOBLIN_T3_DB` points the viewer at another T3 database or a missing one, for tests.
- Measured on the real server: coins rose 951 ms after a turn row landed, 76 to 914 ms over 12 more samples.

### Next

1. Strip UI: coin counter, "+N" pop-ups per `work` event, horde count, level-up, buy and fight buttons.
2. Idle coins are paid only at launch. While the app runs there is no trickle yet, and `lastSeenAt` moves only when a save happens. Decide whether the running app should pay idle coins on a timer.
3. Battle arena under the on-screen sprite cap.
4. Two viewers on different ports that share one state folder no longer both write `pets.json`. The engine holds `pets.lock` (`lib/pets-lock.mjs`), and the second viewer says another Goblin Horde runs the game and saves nothing.
5. `AGENTS.md`, `README.md` and `SECURITY.md` still describe the old agent monitor and its Claude hook. They need rewriting when the monitor code is removed from the T3 edition. The viewer now reads T3's database read-only for token counts and timestamps.
6. Node 20 cannot load `node:sqlite`. The T3 edition should raise `engines.node` to 22.13 or newer.
7. Three older tests in `test/task-routes.test.mjs` are cancelled before and after this work. A cause is known: a test waits on promises whose only timers are unref'd, so Node ends the file early. One ref'ed timer makes all 6 pass.
8. The farmer targets were moved, so a no-AI player who fights 100 battles a day ends with about three quarters of a typical horde at day 90. If that grind proves too rewarding, the alternative in section 11 (coins stop after a boss's third rerun of the day) holds the old targets.
