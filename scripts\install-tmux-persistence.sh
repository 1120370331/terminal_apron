#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

TPM_DIR="${HOME}/.tmux/plugins/tpm"
TMUX_CONF="${HOME}/.tmux.conf"
MARKER_START="# >>> terminal-web-monitor persistence >>>"
MARKER_END="# <<< terminal-web-monitor persistence <<<"

mkdir -p "${HOME}/.tmux/plugins"

if [ ! -d "${TPM_DIR}" ]; then
  git clone https://github.com/tmux-plugins/tpm "${TPM_DIR}"
fi

touch "${TMUX_CONF}"

if ! grep -qF "${MARKER_START}" "${TMUX_CONF}"; then
  cat >>"${TMUX_CONF}" <<'EOF'

# >>> terminal-web-monitor persistence >>>
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '5'
set -g @resurrect-capture-pane-contents 'on'
run '~/.tmux/plugins/tpm/tpm'
# <<< terminal-web-monitor persistence <<<
EOF
fi

tmux start-server
tmux source-file "${TMUX_CONF}" || true

cat <<'EOF'
tmux persistence config installed.

Next:
1. Open tmux.
2. Press prefix + I to install plugins with TPM.
3. Press prefix + Ctrl-s once to create the first resurrect snapshot.
EOF
