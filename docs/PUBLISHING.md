# Publishing Cockpit on GitHub

A step-by-step guide to putting this folder on GitHub as an open-source project that anyone can install with one line.

## 1. Check it before you publish

```bash
cd ~/claude-mods/cockpit
claude plugin validate .     # should print "✔ Validation passed"
claude plugin test .         # should print "2 pass, 0 fail"
```

## 2. Make the first commit

The folder is already a git repository on branch `main`, and `.gitignore` keeps out the engine-generated `.claude-plugin/types/`.

```bash
git add .
git commit -m "Cockpit 0.1.0: mission control for Claude Code"
```

## 3. Create the GitHub repository and push

**With the GitHub CLI** (you're already logged in as `Shashwat-19`):

```bash
gh repo create Shashwat-19/claude-cockpit --public --source . --push \
  --description "✈ Mission control for Claude Code: live agents & subagents, usage charts, git graph, session log, terminal, notifications, ⌥E effort switching"
```

**Or on the website:**
1. Go to github.com/new, name the repository `claude-cockpit`, make it **Public**, and leave every "initialize" box unchecked.
2. Run:
   ```bash
   git remote add origin https://github.com/Shashwat-19/claude-cockpit.git
   git push -u origin main
   ```

> The install line in the README assumes the repository is named `claude-cockpit`. If you pick another name, update `README.md` and `CONTRIBUTING.md`.

## 4. Polish the repository page

```bash
gh repo edit Shashwat-19/claude-cockpit \
  --add-topic claude-code --add-topic claude-code-plugin --add-topic claude \
  --add-topic developer-tools --add-topic dashboard --add-topic ai-agents
gh release create v0.1.0 --title "Cockpit 0.1.0" --notes-file CHANGELOG.md
```

- **Screenshots:** run `/cockpit` in a wide terminal, take a screenshot of each tab, save them under `docs/` (for example `docs/overview.png`), and add `![Overview](docs/overview.png)` lines under **Features** in the README. Screenshots make a big difference to how many people try a project.
- **About box:** add the description and topics. Turn off Wiki and Projects if you won't use them.

## 5. Test the install the way users will

From any Claude Code **terminal** session:

```
/plugin install cockpit --marketplace Shashwat-19/claude-cockpit
```

Answer `y`, press Enter for the user scope, then run `/cockpit`.

> If Cockpit is already installed from your local folder (`cockpit@cockpit`), uninstall that copy first so you're testing the GitHub one:
> `claude plugin uninstall cockpit@cockpit && claude plugin marketplace remove cockpit`

## 6. Ship updates

1. Edit the code, then run `claude plugin validate .` and `claude plugin test .`.
2. Bump `version` in `.claude-plugin/plugin.json` and in `.claude-plugin/marketplace.json` (`metadata.version`).
3. Add an entry to `CHANGELOG.md`.
4. Commit, push and tag:
   ```bash
   git commit -am "Cockpit 0.2.0: ..." && git push
   git tag v0.2.0 && git push --tags
   gh release create v0.2.0 --generate-notes
   ```

Users get the update with `claude plugin update cockpit@cockpit`, then `/reload-plugins`.

## 7. Share it

- Post the install line along with a GIF or screenshot.
- Submit it to community lists of Claude Code plugins and mods.
