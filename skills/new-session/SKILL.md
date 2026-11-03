---
name: new-session
description: /new-session or the whole message "We are starting a new session - read this and let me know when we can start".
metadata:
  engine_version: "3.3.0"
---
`node scripts/memory/new-session.mjs start --entry <slash|sentence> [--goal '<text>']`
Args "sentence": entry sentence; goal from Goal: line. Else slash; strip /new-session and leading Goal:.
Single-quote goal; bash: ' as '\''; PowerShell: ' as ''.
Run only follow-ups named by start. Write nothing. Reply in plain text with no code fence. Use template; omit inapplicable lines.
First line: start's line 1, copied exactly.
( ) notes: do not print; fill <...>; end exactly `Waiting for your go.`.

<abs path> | <branch>@<sha> | <n> changed, <n> untracked | <n> ahead/no upstream | kit <version>[ | flags: ...]
gate: <gate line> | memory: <dir> (<source>)
last handover: <time> @<sha7> <branch> - <state line> | stale <date> vs HEAD <date> | undated | state: none recorded
Q: <open question>   (only when not none)
also handed over (24 h): <time> <branch>: <question> | ...   (only when any; possible parallel session)
waits on you: <item> <link> | ...   (over 3: link the section)
log: <newest line> | rulings: <n | board: not readable here>   (only if the overlay names them)
conflicts: <AGENTS.md vs overlay vs rules file>   (only when any)
goal: <restated> | none given - what is this session for?
first step: <action> - build <model>, review <different model>, because <why>
<named-yes item> - yes or no?   (only when any)
Waiting for your go.
