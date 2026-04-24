#!/bin/sh
# install-hooks.sh — one-shot installer for Sunny HUD git hooks.
#
# Creates .git/hooks/pre-commit as a symlink to the tracked
# scripts/hooks/pre-commit-latency.sh. Idempotent — safe to re-run.
#
# Why a symlink (not a copy):
#   - The committed script is the source of truth. Edits to the tracked file
#     take effect immediately; no "I forgot to re-copy" drift.
#   - `git diff` shows the hook changing alongside the reviewed code.
#
# If .git/hooks/pre-commit already exists and is NOT our symlink, we refuse
# to clobber it and ask the user to chain manually or delete first.
#
# Fork-bomb safety: only filesystem ops. No cargo, no pnpm, no daemons.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_ROOT}" || exit 1

HOOK_SRC_REL="scripts/hooks/pre-commit-latency.sh"
HOOK_SRC_ABS="${REPO_ROOT}/${HOOK_SRC_REL}"
HOOK_DST="${REPO_ROOT}/.git/hooks/pre-commit"
# Symlink target is relative so the link survives repo moves.
SYMLINK_TARGET="../../${HOOK_SRC_REL}"

if [ ! -d "${REPO_ROOT}/.git" ]; then
  echo "install-hooks: this does not look like a git repo (no .git/)" >&2
  exit 1
fi

if [ ! -f "${HOOK_SRC_ABS}" ]; then
  echo "install-hooks: missing source hook at ${HOOK_SRC_REL}" >&2
  exit 1
fi

# Ensure the source hook is executable — without this, git silently skips it.
if [ ! -x "${HOOK_SRC_ABS}" ]; then
  chmod +x "${HOOK_SRC_ABS}"
  echo "install-hooks: chmod +x ${HOOK_SRC_REL}"
fi

mkdir -p "${REPO_ROOT}/.git/hooks"

# Case 1 — no existing hook: install clean.
if [ ! -e "${HOOK_DST}" ] && [ ! -L "${HOOK_DST}" ]; then
  ln -s "${SYMLINK_TARGET}" "${HOOK_DST}"
  echo "install-hooks: installed .git/hooks/pre-commit -> ${SYMLINK_TARGET}"
  echo "install-hooks: done."
  exit 0
fi

# Case 2 — the existing hook is already our symlink: idempotent no-op.
if [ -L "${HOOK_DST}" ]; then
  CURRENT="$(readlink "${HOOK_DST}")"
  if [ "${CURRENT}" = "${SYMLINK_TARGET}" ]; then
    echo "install-hooks: already installed (symlink -> ${SYMLINK_TARGET})"
    exit 0
  fi
  # Different symlink target — surface it, then rewrite.
  echo "install-hooks: replacing symlink (was -> ${CURRENT})"
  rm -f "${HOOK_DST}"
  ln -s "${SYMLINK_TARGET}" "${HOOK_DST}"
  echo "install-hooks: installed .git/hooks/pre-commit -> ${SYMLINK_TARGET}"
  exit 0
fi

# Case 3 — an existing real file sits there (probably a prior copy of another
# team's hook). Refuse to clobber; instruct the operator.
cat >&2 <<EOF
install-hooks: REFUSING to clobber existing .git/hooks/pre-commit (not a symlink).

  Current:  ${HOOK_DST}
  Wanted:   symlink -> ${SYMLINK_TARGET}

  Options:
    1. Back it up and retry:
         mv "${HOOK_DST}" "${HOOK_DST}.backup" && "\$0"
    2. Chain manually by appending a call to ${HOOK_SRC_REL} from your
       existing pre-commit, e.g.:
         "${HOOK_SRC_REL}" || exit 1
EOF
exit 1
