/poteto-mode set up this repo so cloud agents can take tickets and prove their work.
done means one pr on {repo} that adds:
- pstack, installed at the project level and pinned to a version
- a verification skill for this app, made with /create-verification-skill
- a formal verification skill, made with /create-formal-verification-skill
- AGENTS.md with the install, run and test commands, each one actually run
- cloud environment setup so later agents start with dependencies installed
the pr shows the app running and the test suite result.
if pstack's skills aren't available in this session after installing it, say so in the pr instead of faking them.
don't ask me before committing or opening the pr. if you're truly stuck, stop and write up why.
