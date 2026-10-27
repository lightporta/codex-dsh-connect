# Packaged executable paths

The plugin root is three directories above this reference file. Resolve the
existing `bin/codex-dsh-connect.mjs` there for the direct CLI and
`bin/codex-dsh-plugin.mjs` for plugin configuration. Use a supported local Node
executable and an argv array. Do not infer an authorized workspace from those
paths or the process working directory.

For a Skill installed by `skill install`, the installer replaces this reference
with explicit local Node and CLI paths. No credentials are installed here.
