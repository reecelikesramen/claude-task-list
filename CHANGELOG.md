# Changelog

Versions follow [semantic versioning](https://semver.org). The version users
install is the `version` in `.claude-plugin/plugin.json` on `main`; each release
is also tagged `vX.Y.Z`.

## 0.2.5

- Sessions in the same project root share one list: a change is applied to the
  list as stored rather than the session's copy, so one session no longer
  overwrites another's tasks, and each pane picks up the other's changes
  within two seconds. Hiding the pane stays per session.
  ([#2](https://github.com/reecelikesramen/claude-task-list/issues/2))

## 0.2.4

- Desktop: checkboxes are drawn as ☐ / ☒.
- README: on Linux the desktop app may not draw the pane.

## 0.2.3

- Desktop: checkboxes back to `[ ]` / `[x]` while a missing pane on Linux was
  investigated.

## 0.2.2

- A tick, reopen or delete made in the pane shows as one dim line in the
  transcript, in place of a toast.

## 0.2.1

- The pane and the band draw for the surface: outside the terminal there is no
  focus button and there are no key hints.

## 0.2.0

- Quiet by default: what you change in the list reaches the agent with its next
  tool result or your next prompt, and starts no turn. The `autoContinue`
  setting sends it at once.
- Task text is drawn as markdown.
- `task_update` gains `before` (insert) and `move` (reorder).
- `/tasklist keys` and `/tasklist keys install`; key hints in the pane.
- Settings: `paneWidth`, `maxCompleted`, `autoContinue`.
- Completed tasks sort to the bottom, struck through.
- Loads on Claude Code 2.1.284 and later.

## 0.1.0

- First release: the pane, the two agent tools, `/tasklist`, per-project
  persistence.
