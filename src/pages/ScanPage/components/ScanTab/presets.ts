export type PresetKind = 'path' | 'running' | 'last24h' | 'agent-configs' | 'prompt-injection-sweep';

export type Preset = {
  readonly id: string;
  readonly label: string;
  readonly kind: PresetKind;
  readonly path?: string;
  readonly description?: string;
};

export function pathPresets(home: string): ReadonlyArray<Preset> {
  return [
    { id: 'downloads', label: '~/Downloads', kind: 'path', path: `${home}/Downloads` },
    { id: 'desktop', label: '~/Desktop', kind: 'path', path: `${home}/Desktop` },
    { id: 'applications', label: '/Applications', kind: 'path', path: '/Applications' },
    { id: 'user-apps', label: '~/Applications', kind: 'path', path: `${home}/Applications` },
    { id: 'tmp', label: '/tmp', kind: 'path', path: '/tmp' },
    {
      id: 'launch-agents-user',
      label: '~/Library/LaunchAgents',
      kind: 'path',
      path: `${home}/Library/LaunchAgents`,
      description: 'Per-user login items — a classic malware persistence spot.',
    },
    {
      id: 'launch-agents',
      label: '/Library/LaunchAgents',
      kind: 'path',
      path: '/Library/LaunchAgents',
      description: 'System-wide login items.',
    },
    {
      id: 'launch-daemons',
      label: '/Library/LaunchDaemons',
      kind: 'path',
      path: '/Library/LaunchDaemons',
      description: 'Root-level background services.',
    },
  ];
}

export const SMART_PRESETS: ReadonlyArray<Preset> = [
  {
    id: 'running',
    label: 'RUNNING PROCESSES',
    kind: 'running',
    description: 'Hash every executable currently running on this machine.',
  },
  {
    id: 'agent-configs',
    label: 'AGENT CONFIGS',
    kind: 'agent-configs',
    description:
      'Scan ~/.cursor, ~/.claude, ~/.codex, ~/.aider, ~/.continue, plus every AGENTS.md / .cursorrules / CLAUDE.md on disk. Flags prompt-injection, MCP tool spoofs, and rule-tag abuse.',
  },
  {
    id: 'prompt-injection-sweep',
    label: 'PROMPT-INJECTION SWEEP',
    kind: 'prompt-injection-sweep',
    description:
      'Scan text / markdown / prompt / instruction files across the current target path for OWASP LLM01 injection, jailbreak patterns, and invisible-unicode smuggling.',
  },
];

export function agentConfigRoots(home: string): ReadonlyArray<string> {
  return [
    `${home}/.cursor`,
    `${home}/.claude`,
    `${home}/.codex`,
    `${home}/.aider`,
    `${home}/.continue`,
    `${home}/.config/cursor`,
    `${home}/.config/continue`,
    `${home}/.config/aider`,
    `${home}/Library/Application Support/Cursor/User`,
    `${home}/Library/Application Support/Claude`,
  ];
}
