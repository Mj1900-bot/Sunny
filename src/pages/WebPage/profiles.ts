import type { ProfilePolicy } from './types';

// Built-in profile palette. The Rust side already seeds these in
// Dispatcher::new; we mirror them here so the UI can render instantly on
// mount without waiting for the round-trip. On first render we overwrite
// with the server's authoritative copy.
export const BUILTIN_PROFILES: ProfilePolicy[] = [
  {
    id: 'default',
    label: 'Default',
    route: { kind: 'clearnet', doh: 'cloudflare' },
    cookies: 'persistent',
    js_default: 'off_by_default',
    ua_mode: 'pinned_safari',
    block_third_party_cookies: true,
    block_trackers: true,
    block_webrtc: false,
    deny_sensors: true,
    audit: true,
    kill_switch_bypass: false,
    https_only: false,
    security_level: 'standard',
  },
  {
    id: 'private',
    label: 'Private',
    route: { kind: 'clearnet', doh: 'cloudflare' },
    cookies: 'ephemeral',
    js_default: 'off_by_default',
    ua_mode: 'rotate',
    block_third_party_cookies: true,
    block_trackers: true,
    block_webrtc: true,
    deny_sensors: true,
    audit: false,
    kill_switch_bypass: false,
    https_only: true,
    security_level: 'safer',
  },
  {
    id: 'tor',
    label: 'Tor',
    route: { kind: 'system_tor', host: '127.0.0.1', port: 9050 },
    cookies: 'ephemeral',
    js_default: 'off',
    ua_mode: 'pinned_tor_browser',
    block_third_party_cookies: true,
    block_trackers: true,
    block_webrtc: true,
    deny_sensors: true,
    audit: false,
    kill_switch_bypass: false,
    https_only: false,
    security_level: 'safer',
  },
];

export function routeTag(policy: ProfilePolicy): 'CLEAR' | 'PRIVATE' | 'TOR' | 'PROXY' {
  switch (policy.route.kind) {
    case 'clearnet':
      return policy.cookies === 'persistent' ? 'CLEAR' : 'PRIVATE';
    case 'bundled_tor':
    case 'system_tor':
      return 'TOR';
    case 'custom':
      return 'PROXY';
  }
}

export function profileColor(policy: ProfilePolicy): string {
  switch (routeTag(policy)) {
    case 'TOR':
      return 'var(--magenta, #d46bff)';
    case 'PRIVATE':
      return 'var(--amber, #f5b042)';
    case 'PROXY':
      return 'var(--violet, #9b7bff)';
    case 'CLEAR':
    default:
      return 'var(--cyan, #00d8ff)';
  }
}

export function posture(policy: ProfilePolicy): string {
  const parts: string[] = [routeTag(policy)];
  parts.push(
    policy.js_default === 'off' ? 'JS OFF' : policy.js_default === 'on' ? 'JS ON' : 'JS OPT-IN',
  );
  if (policy.security_level === 'safer') parts.push('SAFER');
  if (policy.security_level === 'safest') parts.push('SAFEST');
  if (policy.https_only) parts.push('HTTPS ONLY');
  if (policy.cookies === 'ephemeral') parts.push('EPHEMERAL');
  if (policy.cookies === 'disabled') parts.push('NO COOKIES');
  if (policy.block_trackers) parts.push('TRACKERS BLOCKED');
  if (policy.block_webrtc) parts.push('WEBRTC OFF');
  return parts.join(' \u00b7 ');
}
