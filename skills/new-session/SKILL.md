---
name: new-session
description: /new-session or the whole message "We are starting a new session - read this and let me know when we can start".
metadata:
  engine_version: "3.3.9"
---
`node scripts/memory/new-session.mjs start --entry <slash|sentence> [--goal '<text>']`
Args "sentence": entry sentence; goal from Goal: line. Else slash; strip /new-session and leading Goal:.
Single-quote goal; bash: ' as '\''; PowerShell: ' as ''.
Run only follow-ups start names; write nothing. Reply in Markdown, no code fence, per template, one bullet per item; copy start's values exactly, add no fact; omit empty groups and lines saying none (not Goal). Link files by project-relative path, boards by URL. End exactly `Waiting for your go.` After go, reports follow the Reports line in AGENTS.md.

**<abs path>** - `<branch>` @ `<sha>` - kit <version>[ - flags: ...]
- Git: <n> changed, <n> untracked; <n> ahead|no upstream
- Gate: <gate line>; memory: <dir> (<source>)

**Where we left off**
- Last handover: <time> @<sha7> <branch> - <state line>|stale <date> vs HEAD <date>|undated|none recorded
- Open question: <question>
- Also handed over (24 h): <time> <branch>: <question>
- Log: <newest line>

**Waiting on you**
- <item>: <link>
- Rulings: <start's board reply line>
- Conflicts: <AGENTS.md vs overlay vs rules file>

**This session**
- Goal: <restated>|none given - what is this session for?
- First step: <action> - build <model>, review <different model>, because <why>
- <named-yes item> - yes or no?

Waiting for your go.
