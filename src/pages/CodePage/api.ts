/**
 * Code page — single-repo git inspector.
 *
 * Shells out via `run_shell` for git status, git log, git ls-files,
 * git diff, git show, git blame, git rev-list. Root is configurable
 * and persists across sessions.
 */

import { invokeSafe } from '../../lib/tauri';
import { useView } from '../../store/view';

type ShellResult = { stdout: string; stderr: string; exit_code: number };

async function sh(cmd: string): Promise<ShellResult | null> {
  return invokeSafe<ShellResult>('run_shell', { cmd });
}

export type Report = Readonly<{
  root: string;
  exists: boolean;
  branch: string;
  statusLines: ReadonlyArray<string>;
  logLines: ReadonlyArray<string>;
  totalCommits: number;
  errors: ReadonlyArray<string>;
}>;

export type CommitEntry = Readonly<{
  sha: string;
  author: string;
  relDate: string;
  subject: string;
}>;

export type CommitDetail = Readonly<{
  sha: string;
  message: string;
  stats: ReadonlyArray<string>;
}>;

const KEY = 'sunny.code.root.v2';
const LEGACY_KEY = 'sunny.code.root.v1';
const RECENT_KEY = 'sunny.code.recentRoots.v1';
const MAX_RECENT = 5;

// ---------------------------------------------------------------------------
// Root persistence
// ---------------------------------------------------------------------------

export function loadRoot(): string {
  try {
    const cached = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (cached && cached.length > 0) return cached;
  } catch { /* ignore */ }
  try {
    const storeRoot = useView.getState().settings.codeRepoRoot;
    if (storeRoot && storeRoot.length > 0) return storeRoot;
  } catch { /* settings not ready */ }
  return '~/Sunny Ai';
}

export function saveRoot(v: string): void {
  try { localStorage.setItem(KEY, v); } catch { /* ignore */ }
  pushRecentRoot(v);
}

// ---------------------------------------------------------------------------
// Recent roots (last 5 used repos)
// ---------------------------------------------------------------------------

export function loadRecentRoots(): ReadonlyArray<string> {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT);
  } catch { return []; }
}

function pushRecentRoot(root: string): void {
  try {
    const existing = loadRecentRoots().filter(r => r !== root);
    const next = [root, ...existing].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export async function buildReport(root: string): Promise<Report> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const errors: string[] = [];

  const existCheck = await sh(`test -d ${quoted}/.git && echo ok`);
  const exists = !!existCheck && existCheck.exit_code === 0 && existCheck.stdout.trim() === 'ok';
  if (!exists) {
    return {
      root, exists: false, branch: '',
      statusLines: [], logLines: [], totalCommits: 0,
      errors: [`no git repo at ${root}`],
    };
  }

  const [status, log, revList, branchRes] = await Promise.all([
    sh(`git -C ${quoted} status --porcelain 2>&1`),
    sh(`git -C ${quoted} log --oneline -20 2>&1`),
    sh(`git -C ${quoted} rev-list --count HEAD 2>&1`),
    sh(`git -C ${quoted} branch --show-current 2>&1`),
  ]);

  const collectLines = (r: ShellResult | null, label: string): ReadonlyArray<string> => {
    if (!r) { errors.push(`${label}: invoke failed`); return []; }
    if (r.exit_code !== 0) { errors.push(`${label}: ${r.stderr.trim() || 'exit ' + r.exit_code}`); return []; }
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  };

  const statusLines = collectLines(status, 'git status');
  const logLines = collectLines(log, 'git log');
  const totalCommits = (() => {
    if (!revList || revList.exit_code !== 0) return 0;
    return parseInt(revList.stdout.trim(), 10) || 0;
  })();
  const branch = (branchRes?.stdout || '').trim() || '(detached)';

  return { root, exists: true, branch, statusLines, logLines, totalCommits, errors };
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

/** List all tracked files (git ls-files). */
export async function listFiles(root: string): Promise<ReadonlyArray<string>> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const res = await sh(`git -C ${quoted} ls-files 2>&1`);
  if (!res || res.exit_code !== 0) return [];
  return res.stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Read file contents (via cat on the resolved absolute path). */
export async function readFile(root: string, relPath: string): Promise<string> {
  const abs = `${root}/${relPath}`;
  const quoted = `"${abs.replace(/"/g, '\\"')}"`;
  const res = await sh(`cat ${quoted}`);
  if (!res || res.exit_code !== 0) throw new Error(res?.stderr || 'read failed');
  return res.stdout;
}

/** Get git diff for a single file path. */
export async function fileDiff(root: string, relPath: string): Promise<string> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const pathQ = `"${relPath.replace(/"/g, '\\"')}"`;
  const res = await sh(`git -C ${quoted} diff HEAD -- ${pathQ} 2>&1`);
  if (!res || res.exit_code !== 0) return res?.stderr || 'diff failed';
  return res.stdout || '(no diff — file is unmodified or untracked)';
}

/** Git blame for a file. Returns raw blame output. */
export async function blameFile(root: string, relPath: string): Promise<string> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const pathQ = `"${relPath.replace(/"/g, '\\"')}"`;
  const res = await sh(`git -C ${quoted} blame -- ${pathQ} 2>&1`);
  if (!res || res.exit_code !== 0) return res?.stderr || 'blame failed';
  return res.stdout || '(no blame data)';
}

/** Get file size in bytes. */
export async function fileStat(root: string, relPath: string): Promise<number> {
  const abs = `${root}/${relPath}`;
  const quoted = `"${abs.replace(/"/g, '\\"')}"`;
  const res = await sh(`wc -c < ${quoted}`);
  if (!res || res.exit_code !== 0) return 0;
  return parseInt(res.stdout.trim(), 10) || 0;
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

/** Structured commit log: author + relative date + subject. */
export async function commitLog(root: string, n = 25): Promise<ReadonlyArray<CommitEntry>> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  // Format: sha|author|relative|subject
  const res = await sh(
    `git -C ${quoted} log -${n} --pretty=format:"%h|%an|%ar|%s" 2>&1`,
  );
  if (!res || res.exit_code !== 0) return [];
  return res.stdout
    .split('\n')
    .map(line => {
      const parts = line.split('|');
      if (parts.length < 4) return null;
      const [sha, author, relDate, ...rest] = parts;
      return { sha: sha.trim(), author: author.trim(), relDate: relDate.trim(), subject: rest.join('|').trim() };
    })
    .filter((e): e is CommitEntry => e !== null);
}

/** Detailed stat for a single commit. */
export async function commitDetail(root: string, sha: string): Promise<CommitDetail> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const shaQ = `"${sha.replace(/"/g, '\\"')}"`;
  const res = await sh(`git -C ${quoted} show --stat --format="%B" ${shaQ} 2>&1`);
  if (!res || res.exit_code !== 0) {
    return { sha, message: res?.stderr || 'detail failed', stats: [] };
  }
  const lines = res.stdout.split('\n');
  // First lines until empty line = commit message, rest = file stats
  const msgLines: string[] = [];
  const statLines: string[] = [];
  let pastMessage = false;
  for (const line of lines) {
    if (!pastMessage && line.trim() === '') {
      pastMessage = true;
      continue;
    }
    if (pastMessage) {
      if (line.trim()) statLines.push(line.trim());
    } else {
      msgLines.push(line);
    }
  }
  return { sha, message: msgLines.join('\n').trim(), stats: statLines };
}

/** Summarise changes since last commit via AI. Returns the prompt string
 *  to pass to askSunny — caller decides when to fire. */
export async function buildAiBriefPrompt(root: string, branch: string): Promise<string> {
  const quoted = `"${root.replace(/"/g, '\\"')}"`;
  const [diffRes, logRes] = await Promise.all([
    sh(`git -C ${quoted} diff HEAD --stat 2>&1`),
    sh(`git -C ${quoted} log -5 --pretty=format:"%h %s" 2>&1`),
  ]);
  const diff = diffRes?.stdout?.trim() || '(no diff)';
  const log = logRes?.stdout?.trim() || '(no log)';
  return (
    `Summarise the current state of the git repo at ${root} (branch: ${branch}). ` +
    `Last 5 commits:\n${log}\n\nUncommitted changes:\n${diff}\n\n` +
    `Give a 3-sentence technical brief: what changed, what it implies, and the most important next action.`
  );
}
