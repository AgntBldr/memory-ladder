## Session overlay
roadmap: <path> | section: <heading>
branch: <branch>
main-only: yes|no
check: <read-only command>
rules: <optional path to a project instructions file>
after-go: <project skills, in order>
close: <up to 3 skills or commands, semicolon-separated in order, run these before /handover's run, reports each ok|failed, missing/failed is NOT SAFE>
push: <memory|project|none; /handover defaults to memory; project only in-repo>
log: <path>, <n> lines
board: <optional read-only command that prints open decisions>
public: yes|no

Replace placeholders (including <branch>); omit unused keys; filled section <= 1,500 B. After go, name and run after-go items one at a time.
Precedence: AGENTS.md outside overlay > overlay > rules file > kit defaults; name conflicts. In a public repository, keep personal paths and private settings out of the overlay.
