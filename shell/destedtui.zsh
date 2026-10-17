# destedtui shell integration for zsh (the `sal` WSL distro). Mirrors
# shell/destedtui.ps1; read that file's header for the why.
#
# Source this from ~/.zshrc.local (destedtui --install-shell does that for you).
# It gives you:
#
#   proj / pj      open the project picker; enter cds the CURRENT shell there
#   dested         short alias for the destedtui bin (dested --backup, etc.)
#   term           jump straight into the terminal multiplexer, here
#   ports          every node/bun server listening on localhost: open, cd, kill
#   procs          what every claude session spun up: cpu, orphans, kill
#   save-sessions <name>     tabs save <name>: snapshot this Windows Terminal window's tabs
#   restore-sessions [name]  tabs restore [name]: tick tabs, reopen them in this window
#   auto-launch    the picker opens by itself when an interactive shell starts
#                  in the projects root (the `sal` terminal profile's /w/code)
#
# THE cd TRICK: a child can't change its parent shell's directory, so we hand
# destedtui a temp file via DESTEDTUI_CD_FILE, it writes the chosen path (and
# an optional command on line 2) there before exiting, and we cd + eval here.
# No file written = you pressed esc.
#
# Escape hatches:
#   DESTEDTUI_NO_AUTOSTART=1     turn the auto-launch off (term panes set it)
#   DESTEDTUI_PROJECTS_ROOT      scan somewhere other than /w/code

typeset -g DESTEDTUI_ROOT=${DESTEDTUI_PROJECTS_ROOT:-/w/code}

# Runs destedtui with the cd handoff wired up. Shared by `proj`, `ports` and
# `procs`: any screen that can "go to a folder" needs it.
_destedtui_cd() {
  if (( ! $+commands[destedtui] )); then
    print -u2 "destedtui is not on PATH - run 'bun link' in /w/code/destedtui"
    return 1
  fi
  local cd_file="${TMPDIR:-/tmp}/destedtui-cd-$$-$RANDOM$RANDOM.txt"
  DESTEDTUI_CD_FILE=$cd_file destedtui "$@"
  [[ -f $cd_file ]] || return 0

  # Line 1 is the directory; an optional line 2 is a command to run there (the
  # card's dev / claude buttons). Running it HERE rather than inside destedtui
  # is the whole point: it gets your real interactive terminal.
  local -a lines
  lines=("${(@f)$(<$cd_file)}")
  command rm -f -- $cd_file
  local target=${lines[1]%$'\r'} cmd=${lines[2]%$'\r'}
  [[ -n $target && -d $target ]] || return 0
  cd -- $target || return
  if [[ -n $cmd ]]; then
    print -s -- $cmd
    eval $cmd
  fi
}

proj() { _destedtui_cd --projects }
alias pj=proj

# `dested` is just the bin under a shorter name: `dested --term`, `dested --local`.
alias dested=destedtui

# `term` drops you into the terminal multiplexer, panes rooted at THIS shell's
# directory. No cd handoff: you stay where you are.
term() {
  if (( ! $+commands[destedtui] )); then
    print -u2 "destedtui is not on PATH - run 'bun link' in /w/code/destedtui"
    return 1
  fi
  destedtui --term
}

ports() { _destedtui_cd --ports }
procs() { _destedtui_cd --procs }

# The `tabs` bin by full path: plain `tabs` is also ncurses' tab-stop tool
# (/usr/bin/tabs), which wins whenever ~/.bun/bin isn't first on PATH.
_destedtui_tabs() {
  local bin=$HOME/.bun/bin/tabs
  if [[ ! -x $bin ]]; then
    print -u2 "tabs isn't linked - run 'bun link' in /w/code/destedtui"
    return 1
  fi
  $bin "$@"
}
save-sessions() { _destedtui_tabs save "$@" }
restore-sessions() { _destedtui_tabs restore "$@" }

# Only a real interactive terminal that STARTED in the projects root: never a
# `zsh -c`/`-ic` command, a pipe, a term pane, a `dev` pane (SAL_RUN), an agent
# or CI. Opening a shell inside a project means you already know where you're going.
_destedtui_autostart() {
  [[ -o interactive && -t 0 && -z $ZSH_EXECUTION_STRING ]] || return 1
  [[ -z $DESTEDTUI_NO_AUTOSTART && -z $SAL_RUN && -z $CLAUDECODE && -z $CI ]] || return 1
  (( $+commands[destedtui] )) || return 1
  [[ ${PWD%/} == "${DESTEDTUI_ROOT%/}" ]]
}

_destedtui_autostart && proj
