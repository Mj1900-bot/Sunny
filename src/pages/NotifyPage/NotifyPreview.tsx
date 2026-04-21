/**
 * macOS-style notification banner mockup — a pure visual preview.
 * Shows how a notification will look before the user actually sends it.
 */

type Props = {
  readonly title: string;
  readonly body: string;
};

export function NotifyPreview({ title, body }: Props) {
  if (!title.trim()) return null;
  return (
    <div style={{
      position: 'relative',
      border: '1px solid rgba(255,255,255,0.12)',
      borderRadius: 14,
      background: 'rgba(30,30,32,0.92)',
      backdropFilter: 'blur(20px)',
      padding: '10px 14px',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      boxShadow: '0 4px 24px rgba(0,0,0,0.55), 0 0 0 1px rgba(57, 229, 255, 0.1)',
      maxWidth: 340,
      animation: 'fadeIn 220ms ease-out',
    }}>
      {/* App icon placeholder */}
      <div style={{
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        background: 'linear-gradient(135deg, var(--cyan), var(--violet))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--display)', fontSize: 11, fontWeight: 800,
        color: '#000', letterSpacing: '0.05em',
      }}>SUNNY</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          marginBottom: 1,
        }}>
          <span style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.55)',
          }}>Sunny</span>
          <span style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 10, color: 'rgba(255,255,255,0.35)',
          }}>now</span>
        </div>
        <div style={{
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 13, fontWeight: 600, color: '#fff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</div>
        {body.trim() && (
          <div style={{
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            fontSize: 12, color: 'rgba(255,255,255,0.6)',
            marginTop: 1, lineHeight: 1.35,
            overflow: 'hidden', textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as const,
          }}>{body}</div>
        )}
      </div>
    </div>
  );
}
