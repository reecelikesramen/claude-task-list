# Security

Please report a vulnerability privately, through
[Report a vulnerability](https://github.com/reecelikesramen/claude-task-list/security/advisories/new)
on this repository, and not in a public issue.

The mod runs inside Claude Code with the access a plugin has there: it reads and
writes its own task list store, and `/tasklist keys install` writes key bindings
to your `keybindings.json`. It makes no network requests.
