import { convertFileSrc } from '@tauri-apps/api/core';
import { isTauri } from '../../lib/tauri';
import { SafeHtml } from '../../components/SafeHtml';
import { IMG_EXTS } from './constants';
import { KIND_STYLES } from './utils';
import { SectionHeader, ToolbarBtn } from './components';
import { fmtRelative, fmtSize, getExt, kindColor, kindLabel } from './utils';
import type { Entry, FsDirSize, FsReadText } from './types';

// ---------------------------------------------------------------------------
// PreviewPane — right sidebar showing file/dir details
// ---------------------------------------------------------------------------

function PreviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8 }}>
      <span style={{ color: 'var(--ink-dim)' }}>{label}</span>
      <span style={{ color: 'var(--ink-2)', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

const MD_EXTS = new Set(['md', 'mdx']);
const CODE_PREVIEW_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'sh']);

const CODE_KEYWORDS = new Set([
  // JS / TS
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'implements', 'interface', 'type', 'enum',
  'new', 'this', 'super', 'async', 'await', 'try', 'catch', 'finally',
  'throw', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined',
  // Python
  'def', 'lambda', 'with', 'as', 'in', 'is', 'not', 'and', 'or', 'pass',
  'yield', 'raise', 'except', 'print', 'None', 'True', 'False',
  // Shell
  'echo', 'fi', 'then', 'do', 'done', 'elif', 'esac',
]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function prettyPreview(content: string, ext: string): string {
  if (ext === 'json') {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return content;
    }
  }
  return content;
}

function renderMarkdownHtml(md: string): string {
  // Minimal transform: # H → <h1>, *bold* → <strong>, `code` → <code>.
  // SafeHtml whitelist strips everything except approved <span class=…>,
  // so we emit spans with approved classes instead of raw <h1>/<strong>.
  const escaped = escapeHtml(md);
  return escaped
    .replace(/^# +(.*)$/gm, '<span class="cyan">$1</span>')
    .replace(/\*([^*]+)\*/g, '<span class="warn">$1</span>')
    .replace(/`([^`]+)`/g, '<span class="cmd">$1</span>');
}

function renderCodeTinted(content: string): string {
  // Escape once, then tint:
  //   * strings in double / single / backtick quotes → --green
  //   * known keywords → --violet
  // We rely on SafeHtml's span-only whitelist — keywords wrap in
  // <span class="cmd"> (mapped via CSS to violet) and strings in
  // <span class="ok"> (mapped to green).
  const escaped = escapeHtml(content);
  // Strings first so we don't re-tint tokens inside a literal.
  const withStrings = escaped.replace(
    /("[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'|`[^`\\]*(?:\\.[^`\\]*)*`)/g,
    '<span class="ok">$1</span>',
  );
  return withStrings.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (match, word: string) =>
    CODE_KEYWORDS.has(word) ? `<span class="cmd">${word}</span>` : match,
  );
}

export function PreviewPane({
  entry, preview, previewFor, dirMeta, dirMetaFor, nowSecs,
  onOpen, onReveal, onCopyPath, onRename, onTrash, onDuplicate,
}: {
  entry: Entry;
  preview: FsReadText | null;
  previewFor: string | null;
  dirMeta: FsDirSize | null;
  dirMetaFor: string | null;
  nowSecs: number;
  onOpen: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onRename: () => void;
  onTrash: () => void;
  onDuplicate: () => void;
}) {
  const ext = getExt(entry.name);
  const isImg = IMG_EXTS.has(ext);
  const kStyle = KIND_STYLES[kindColor(entry)];

  return (
    <aside
      className="section"
      style={{
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <style>{`
        .fp-code .cmd { color: var(--violet); }
        .fp-code .ok { color: var(--green); }
        .fp-md .cyan { color: var(--cyan); font-weight: 700; }
        .fp-md .warn { color: var(--amber); font-weight: 700; }
        .fp-md .cmd { color: var(--green); }
      `}</style>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <SectionHeader label="PREVIEW" />
        <div
          style={{
            fontFamily: 'var(--label)',
            color: 'var(--ink)',
            fontWeight: 600,
            wordBreak: 'break-all',
            fontSize: 13,
            lineHeight: 1.35,
          }}
        >
          {entry.name}
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink-dim)',
            letterSpacing: '0.12em',
            wordBreak: 'break-all',
          }}
        >
          {entry.path}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: '1px solid var(--line-soft)',
          background: 'rgba(4, 10, 16, 0.55)',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {isImg && isTauri ? (
          <img
            src={convertFileSrc(entry.path)}
            alt={entry.name}
            style={{ width: '100%', height: 'auto', objectFit: 'contain', display: 'block' }}
          />
        ) : entry.is_dir ? (
          <div
            style={{
              padding: 12,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--ink-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              letterSpacing: '0.1em',
            }}
          >
            <PreviewRow label="KIND" value="DIRECTORY" />
            {dirMetaFor === entry.path && dirMeta ? (
              <>
                <PreviewRow label="TOTAL" value={fmtSize(dirMeta.size)} />
                <PreviewRow label="FILES" value={dirMeta.files.toLocaleString()} />
                <PreviewRow label="SUBDIRS" value={dirMeta.dirs.toLocaleString()} />
                {dirMeta.truncated && (
                  <PreviewRow label="NOTE" value="walk truncated" />
                )}
              </>
            ) : (
              <PreviewRow label="SIZE" value="computing…" />
            )}
            <PreviewRow label="MODIFIED" value={fmtRelative(entry.modified_secs, nowSecs)} />
          </div>
        ) : preview && previewFor === entry.path ? (
          preview.is_binary ? (
            <div style={{ padding: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)', letterSpacing: '0.14em' }}>
              BINARY · {fmtSize(preview.total_size)}
            </div>
          ) : MD_EXTS.has(ext) ? (
            <pre
              className="fp-md"
              style={{
                margin: 0,
                padding: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--ink-2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <SafeHtml html={renderMarkdownHtml(preview.content)} />
              {preview.truncated && '\n\n… [truncated]'}
            </pre>
          ) : CODE_PREVIEW_EXTS.has(ext) ? (
            <pre
              className="fp-code"
              style={{
                margin: 0,
                padding: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--ink-2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              <SafeHtml html={renderCodeTinted(preview.content)} />
              {preview.truncated && '\n\n… [truncated]'}
            </pre>
          ) : (
            <pre
              style={{
                margin: 0,
                padding: 10,
                fontFamily: 'var(--mono)',
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--ink-2)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {prettyPreview(preview.content, ext)}
              {preview.truncated && '\n\n… [truncated]'}
            </pre>
          )
        ) : entry.size > 2 * 1024 * 1024 ? (
          <div style={{ padding: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
            FILE TOO LARGE TO PREVIEW · {fmtSize(entry.size)}
          </div>
        ) : (
          <div style={{ padding: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-dim)' }}>
            loading…
          </div>
        )}
      </div>

      {/* Meta */}
      {!entry.is_dir && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: 'var(--mono)',
            fontSize: 10,
            color: 'var(--ink-dim)',
            letterSpacing: '0.12em',
          }}
        >
          <PreviewRow
            label="KIND"
            value={<span style={{ color: kStyle.color }}>{kindLabel(entry)}</span>}
          />
          <PreviewRow label="SIZE" value={fmtSize(entry.size)} />
          <PreviewRow label="MODIFIED" value={fmtRelative(entry.modified_secs, nowSecs)} />
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <ToolbarBtn onClick={onOpen}>OPEN</ToolbarBtn>
        <ToolbarBtn onClick={onReveal}>REVEAL</ToolbarBtn>
        <ToolbarBtn onClick={onCopyPath}>COPY PATH</ToolbarBtn>
        <ToolbarBtn onClick={onRename}>RENAME</ToolbarBtn>
        <ToolbarBtn onClick={onDuplicate}>DUPLICATE</ToolbarBtn>
        <ToolbarBtn tone="red" onClick={onTrash}>TRASH</ToolbarBtn>
      </div>
    </aside>
  );
}
