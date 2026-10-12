<div align="center">

# ✈ Cockpit

**Mission control for [Claude Code](https://code.claude.com).**
See what the main agent and every subagent is doing, where your tokens go, and your repo's history. Switch effort with one key and get notified when the work is done.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-d97757.svg)

</div>

---

## Install

In a Claude Code **terminal** session, type:

```
/plugin install cockpit --marketplace Shashwat-19/claude-cockpit
```

1. Answer `y` to add the marketplace.
2. Press Enter to install at the **user** scope, so Cockpit loads in every session, the desktop app included.

Then run `/cockpit`.

<details>
<summary>Install from a local clone instead</summary>

```bash
git clone https://github.com/Shashwat-19/claude-cockpit.git ~/claude-mods/cockpit
claude plugin marketplace add ~/claude-mods/cockpit
claude plugin install cockpit@cockpit --scope user
```

Claude Code reads the plugin from that folder. After editing it, run `/reload-plugins`.
</details>

### Optional: ⌥E / ⌥⇧E for effort

Merge [`examples/keybindings.json`](examples/keybindings.json) into `~/.claude/keybindings.json`.

On macOS your terminal must send Option as Meta:
- **iTerm2:** Profiles → Keys → Left Option key = *Esc+*
- **Terminal.app:** Settings → Profiles → Keyboard → *Use Option as Meta key*

---

## Features

### Status line
A live line under the prompt:

```
⠹ main working 14s · Bash npm test  │  ⑂ subagents 2 running · 3/5 done  │  ⚡ High  │  Σ 48.2k tok · $0.412 · ctx 31%
```

### Band above the prompt
Shows main agent status, running and finished subagents, tokens and context, plus an **effort gauge**:

```
✈ Cockpit │ main ✓ done 42s │ ⑂ 0 running 3 done │ Σ 48.2k ctx 31%      ⚡ ◀ ▰▰▰▱▱ ▶ High  ⌥E up · ⌥⇧E down
```

Click a segment to jump to that level, or click ◀ ▶.

### `/cockpit`: a seven-tab pane
With the pane focused, press `1`–`7` to switch tabs.

| Tab | What you get |
| --- | --- |
| **Overview** | Cards for the main agent, subagents, tokens and context, plus the effort control and a live activity feed |
| **Agents** | A fleet tree (main plus nested subagents) showing **the tool each agent is running right now**. Also a swimlane timeline, bar charts of tool calls, tokens and duration per subagent, and a detail drawer with each agent's tool mix |
| **Usage** | KPI tiles (input, output, cache, cost), a context window bar, plan rate-limit bars, a **tokens-per-turn column chart** (main vs subagents), and a split by model |
| **Git** | Branch, ahead/behind, changed files, and a colored `git log --graph --all`. Press `r` to refresh |
| **Logs** | The session log of prompts, tools, agents, turns, errors and alerts. Filter chips, paging, click a row to inspect it, and **Export** to `~/.claude/cockpit-logs/<session>.jsonl` |
| **Terminal** | A zsh prompt in the session folder, separate from Claude's turn, with streaming output, Stop, Clear and quick commands |
| **Settings** | Notifications, effort, subagent customisation and display toggles |

### Commands
| Command | Does |
| --- | --- |
| `/cockpit [tab]` | Opens the pane, optionally on a tab |
| `/fleet` | Opens the Agents tab |
| `/usage-chart` | Draws a token chart inline in the conversation |
| `/session-log` | Opens the Logs tab |
| `/git-graph` | Opens the Git tab |
| `/effort-up`, `/effort-down` | Changes effort; works everywhere, including the desktop app |

### Notifications
Set these separately for the main agent and for subagents: **Off · Pop-up · System · Both**. You can also notify only for turns longer than 10s, 30s, 1m or 2m, and choose whether errors notify. Where system notifications aren't available, Cockpit shows the pop-up instead.

### Subagent customisation
- **Model override:** run every subagent on Haiku, Sonnet or Opus.
- **Effort override:** applies to every subagent request.
- **Always background:** keep chatting while subagents work.
- **Preset agent types:** `cockpit:reviewer`, `cockpit:tester` and `cockpit:scout` (Haiku). Turn each on or off.

---

## How it works

Cockpit is a **Claude Code mod**: a hooks module that Claude Code loads into a sandbox with no DOM and no Node. It reaches the engine only through the `$` interface.

| Hook | Used for |
| --- | --- |
| `turn.start` / `turn.complete` | Main and subagent run status, token usage per turn, notifications |
| `tool.call` | "What is each agent running now", tool counts and errors, timeline hits |
| `agent.spawn` / `agent.offer` | Subagent tracking, model/effort/background overrides, preset types |
| `turn.step` | Applies the chosen effort level to each model request |
| `session.measure` | Context window, cost and plan rate limits |
| `ui.render` (Pane, AbovePrompt, CommandOutput) | The pane, the band and the inline usage chart |

State lives in host-held `$.state` values (declared in [`types/index.d.ts`](types/index.d.ts)), so a hot reload keeps it. Settings are saved with `$.store`, so they last across sessions.

```
.
├── .claude-plugin/
│   ├── plugin.json        # manifest
│   └── marketplace.json   # makes this repo installable with /plugin install
├── hooks/
│   ├── hooks.json         # names the hooks module
│   ├── register.tsx       # every hook, view and action (code that uses $ must live here)
│   └── lib.ts             # pure helpers: formatting, text charts
├── types/index.d.ts       # the $.state contract
├── tests/cockpit.test.ts  # claude plugin test .
└── examples/keybindings.json
```

## Development

```bash
claude plugin validate .   # checks the manifest and module the way the engine will
claude plugin test .       # runs tests/*.test.ts against the engine (terminal and desktop surfaces)
claude --plugin-dir .      # runs a session with this folder loaded; saving a file hot-reloads it
```

When Claude Code loads the folder it writes the API types into `.claude-plugin/types/` (gitignored). After that, `npx tsc -p .` type-checks the mod.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Limitations

- The ⌥E chords work in **terminal** sessions only. In the desktop app, use the gauge or `/effort-up` and `/effort-down`.
- Effort is applied per request. If a model rejects a level, pick *Model default* in Settings.
- Cockpit only sees work from sessions it's loaded in. It doesn't read old transcripts.

## License

[MIT](LICENSE)
