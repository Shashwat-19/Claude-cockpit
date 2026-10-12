# Contributing to Cockpit

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Set up

```bash
git clone https://github.com/Shashwat-19/claude-cockpit.git
cd claude-cockpit
claude --plugin-dir .
```

Running with `--plugin-dir` loads your working copy, and every save hot-reloads it. Run with `claude --debug` to see why a hook was skipped or a tree was refused. Look for lines that start with `cockpit:`.

## Before you open a PR

```bash
claude plugin validate .   # must pass
claude plugin test .       # must pass
npx tsc -p .               # after one load, so .claude-plugin/types/ exists
```

## Rules of the codebase

- **Code that takes `$` must live in `hooks/register.tsx`.** The validator follows `$` only into functions declared in the same file. Pure helpers with no `$` go in `hooks/lib.ts`.
- **Keep drawing state in `$.state`, not in module variables**, because a reload wipes module variables. Declare every new value in `types/index.d.ts` under `PluginState.cockpit`.
- **Render hooks never write state.** Write from `onPress`/`onSubmit` handlers or from other events, using `update($, atom, fn)`.
- **Don't name a type in `types/index.d.ts` after one that `claude-code` already exports.** Inside `declare module 'claude-code'`, the engine's type wins. That's why our settings type is `CockpitSettings`, not `Settings`.
- **Draw for every surface.** Use only `Box`, `Text` and `Button` everywhere, and check before using `Input`, which mobile doesn't have. Tests loop over `['terminal', 'desktop']`.
- **Observer hooks pass through on failure.** Add `.catch(($, e, next) => next(e))` to them.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Add an entry to `CHANGELOG.md`.
3. Tag the release: `git tag v0.x.y && git push --tags`.

Users update with `claude plugin update cockpit@cockpit`.
