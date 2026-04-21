const S = { className: 'ic', viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1.5 };

export function NavIcon({ name }: { name: string }) {
  switch (name) {
    // ── CORE ───────────────────────────────────────────────────────────
    case 'hub':
      return (<svg {...S}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>);
    case 'security':
      return (
        <svg {...S}>
          <path d="M8 1.5 L13.5 4 V8 Q13.5 12 8 14.5 Q2.5 12 2.5 8 V4 Z" />
          <path d="M5.5 8.2 L7.3 10 L10.7 6.4" strokeWidth="1.3" />
        </svg>
      );
    case 'today':
      return (<svg {...S}><circle cx="8" cy="8" r="6" /><path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5" /><path d="M8 5v3l2 1.5" /></svg>);
    case 'timeline':
      return (<svg {...S}><path d="M2 8h12" /><circle cx="4" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12" cy="8" r="1.4" fill="currentColor" /></svg>);

    // ── LIFE ───────────────────────────────────────────────────────────
    case 'tasks':
      return (<svg {...S}><path d="M3 4h10M3 8h10M3 12h6" /><path d="M12.5 11.5l1 1 2-2.5" strokeWidth="1.2" /></svg>);
    case 'journal':
      return (<svg {...S}><path d="M4 2h7l2 2v10H4z" /><path d="M6 6h5M6 9h5M6 12h3" /></svg>);
    case 'focus':
      return (<svg {...S}><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2.5" /><circle cx="8" cy="8" r="0.8" fill="currentColor" /></svg>);
    case 'calendar':
      return (<svg {...S}><rect x="2.5" y="3.5" width="11" height="10" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></svg>);

    // ── COMMS ──────────────────────────────────────────────────────────
    case 'inbox':
      return (<svg {...S}><path d="M2 8.5 V13 H14 V8.5 L11.5 3 H4.5 Z" /><path d="M2 8.5h3l1 2h4l1-2h3" /></svg>);
    case 'people':
      return (<svg {...S}><circle cx="5.5" cy="6" r="2.2" /><circle cx="10.5" cy="7" r="1.8" /><path d="M2 13c0-2 1.8-3.5 3.5-3.5S9 11 9 13" /><path d="M9 13c0-1.6 1.1-2.6 2-2.6S13.5 11.6 13.5 13" /></svg>);
    case 'contacts':
      return (<svg {...S}><circle cx="8" cy="6" r="3" /><path d="M3 14c0-3 2.5-5 5-5s5 2 5 5" /></svg>);
    case 'voice':
      return (<svg {...S}><rect x="6" y="2" width="4" height="8" rx="2" /><path d="M3.5 8.5a4.5 4.5 0 0 0 9 0" /><path d="M8 13v1.5" /></svg>);
    case 'notify':
      return (<svg {...S}><path d="M3.5 11 L3.5 8 a4.5 4.5 0 0 1 9 0 L12.5 11 Z" /><path d="M3 11h10" /><path d="M7 13a1 1 0 0 0 2 0" /></svg>);

    // ── KNOWLEDGE ──────────────────────────────────────────────────────
    case 'notes':
      return (<svg {...S}><path d="M3 2h8l2 2v10H3z" /><path d="M5 5h6M5 8h6M5 11h4" /></svg>);
    case 'reading':
      return (<svg {...S}><path d="M2.5 3.5h5a1.5 1.5 0 0 1 1.5 1.5v8 M13.5 3.5h-5A1.5 1.5 0 0 0 7 5v8" /><path d="M2.5 3.5v9h5M13.5 3.5v9h-5" /></svg>);
    case 'memory':
      return (<svg {...S}><rect x="3" y="4" width="10" height="8" /><path d="M5 4V2M8 4V2M11 4V2M5 14v-2M8 14v-2M11 14v-2" /><path d="M5 7h6M5 10h6" /></svg>);
    case 'photos':
      return (<svg {...S}><rect x="2" y="3" width="12" height="10" /><circle cx="6" cy="7" r="1.2" /><path d="M2 11l3-3 3 3 2-2 4 4" /></svg>);
    case 'files':
      return (<svg {...S}><path d="M2 4h4l1 1.5h7V13H2z" /></svg>);

    // ── DO ─────────────────────────────────────────────────────────────
    case 'auto':
      return (<svg {...S}><circle cx="8" cy="8" r="5" /><path d="M8 4.5v2l1.5 1.5" /><path d="M3 8h-1M14 8h-1M8 3v-1M8 14v-1" /></svg>);
    case 'skills':
      return (<svg {...S}><path d="M8 2l2 3.5 4 0.6-3 2.9 0.7 4L8 11l-3.7 2 0.7-4-3-2.9 4-0.6z" /></svg>);
    case 'apps':
      return (<svg {...S}><rect x="2" y="2" width="5" height="5" /><rect x="9" y="2" width="5" height="5" /><rect x="2" y="9" width="5" height="5" /><rect x="9" y="9" width="5" height="5" /></svg>);
    case 'web':
      return (<svg {...S}><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></svg>);
    case 'code':
      return (<svg {...S}><path d="M5 5 L2 8 L5 11 M11 5 L14 8 L11 11 M9.5 3L6.5 13" /></svg>);
    case 'console':
      return (<svg {...S}><rect x="2" y="3" width="12" height="10" /><path d="M4.5 6.5l2 2-2 2M8 10h3" /></svg>);
    case 'screen':
      return (<svg {...S}><rect x="2" y="4" width="12" height="8" /><path d="M6 12v2M10 12v2" /></svg>);
    case 'scan':
      return (
        <svg {...S}>
          <path d="M8 2 L13 4 V8 Q13 12 8 14 Q3 12 3 8 V4 Z" />
          <path d="M5.5 8 Q8 6.5 10.5 8" />
          <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );

    // ── AI & SYSTEM ────────────────────────────────────────────────────
    case 'world':
      return (<svg {...S}><circle cx="8" cy="8" r="6" /><path d="M4 5.5c2 1.5 6 1.5 8 0M4 10.5c2-1.5 6-1.5 8 0M8 2v12" /></svg>);
    case 'society':
      return (<svg {...S}><circle cx="8" cy="4.5" r="1.7" /><circle cx="4" cy="11" r="1.7" /><circle cx="12" cy="11" r="1.7" /><path d="M8 6.5L5 9.5M8 6.5L11 9.5M5.5 11.5h5" /></svg>);
    case 'brain':
      return (<svg {...S}><path d="M4.5 4 a2 2 0 0 1 2-2 h3 a2 2 0 0 1 2 2 a2 2 0 0 1 0 4 a2 2 0 0 1 -2 6 h-3 a2 2 0 0 1 -2 -2 a2 2 0 0 1 0 -8" /><path d="M7.5 5v6M6 7h3M6 9h3" /></svg>);
    case 'persona':
      return (<svg {...S}><path d="M3.5 13c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><circle cx="8" cy="6" r="2.5" /><path d="M5 4.5L7 3M11 4.5L9 3" /></svg>);
    case 'inspector':
      return (<svg {...S}><rect x="2" y="2.5" width="11" height="8" /><path d="M5 5.5h5M5 7.5h3" /><path d="M10.5 10.5l3 3M12 11.5 a1.5 1.5 0 1 0 0 -0.01" /></svg>);
    case 'audit':
      return (<svg {...S}><path d="M8 1.5L13.5 4v4c0 3-2.5 5.5-5.5 6.5C5 13.5 2.5 11 2.5 8V4z" /><path d="M5.5 8l2 2 3-4" /></svg>);
    case 'devices':
      return (<svg {...S}><rect x="2.5" y="3.5" width="11" height="7" /><path d="M5 13.5h6M8 10.5v3M3 6.5h1M3 8.5h1" /></svg>);
    case 'vault':
      return (<svg {...S}><path d="M4 3h8v10H4z M7 6h2 M7 9h2" /></svg>);
    case 'settings':
      return (
        <svg {...S}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.3 3.3l1.4 1.4 M11.3 11.3l1.4 1.4 M3.3 12.7l1.4-1.4 M11.3 4.7l1.4-1.4" />
        </svg>
      );

    default:
      return null;
  }
}
