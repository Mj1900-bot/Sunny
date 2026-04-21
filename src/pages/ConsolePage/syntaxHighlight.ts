/**
 * Minimal syntax highlight tokeniser.
 * Returns an array of {text, kind} tokens — no external deps.
 */

export type TokenKind = 'kw' | 'str' | 'num' | 'comment' | 'plain';
export type Token = { text: string; kind: TokenKind };

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield', 'print', 'range', 'len', 'type',
]);

const SH_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done',
  'case', 'esac', 'in', 'echo', 'export', 'local', 'return', 'function',
  'source', 'cd', 'ls', 'rm', 'cp', 'mv', 'mkdir', 'chmod', 'grep',
  'awk', 'sed', 'cat', 'curl', 'git', 'pip', 'python', 'python3',
]);

export function tokenise(code: string, lang: 'py' | 'sh'): ReadonlyArray<Token> {
  const keywords = lang === 'py' ? PY_KEYWORDS : SH_KEYWORDS;
  const tokens: Token[] = [];
  let i = 0;

  while (i < code.length) {
    // Comment
    if ((lang === 'py' || lang === 'sh') && code[i] === '#') {
      const end = code.indexOf('\n', i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      tokens.push({ text, kind: 'comment' });
      i += text.length;
      continue;
    }

    // String (single or double quote, or triple for py)
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      const triple = lang === 'py' && code.slice(i, i + 3) === q + q + q;
      const endSeq = triple ? q + q + q : q;
      const start = i;
      i += endSeq.length;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code.slice(i, i + endSeq.length) === endSeq) { i += endSeq.length; break; }
        i++;
      }
      tokens.push({ text: code.slice(start, i), kind: 'str' });
      continue;
    }

    // Number
    if (/[0-9]/.test(code[i])) {
      const start = i;
      while (i < code.length && /[0-9._xXa-fA-F]/.test(code[i])) i++;
      tokens.push({ text: code.slice(start, i), kind: 'num' });
      continue;
    }

    // Word (keyword or plain identifier)
    if (/[a-zA-Z_$]/.test(code[i])) {
      const start = i;
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++;
      const word = code.slice(start, i);
      tokens.push({ text: word, kind: keywords.has(word) ? 'kw' : 'plain' });
      continue;
    }

    // Anything else: single char
    tokens.push({ text: code[i], kind: 'plain' });
    i++;
  }

  return tokens;
}

export const TOKEN_COLOR: Record<TokenKind, string> = {
  kw: 'var(--cyan)',
  str: 'var(--green)',
  num: 'var(--gold)',
  comment: 'var(--ink-dim)',
  plain: 'var(--ink)',
};
