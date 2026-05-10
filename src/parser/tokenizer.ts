export interface Token {
  type: 'keyword' | 'identifier' | 'string' | 'number' | 'symbol' | 'comment' | 'whitespace';
  value: string;
  position: number;
}

export function tokenizeJava(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let pos = 0;

  const regexes: Array<{ type: Token['type']; regex: RegExp }> = [
    { type: 'comment', regex: /\/\/[^\n]*|\/\*[\s\S]*?\*\// },
    { type: 'string', regex: /"(?:[^"\\]|\\.)*"/ },
    { type: 'number', regex: /\b\d+(?:\.\d+)?[fFdDlL]?\b/ },
    { type: 'keyword', regex: /\b(?:new|return|if|else|for|while|switch|case|break|continue|this|null|true|false|public|private|protected|static|final|void|int|double|float|long|short|byte|boolean|char|String|var)\b/ },
    { type: 'identifier', regex: /\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/ },
    { type: 'symbol', regex: /[+\-*/%=<>!&|^~?:;.,{}()\[\]]/ },
    { type: 'whitespace', regex: /\s+/ },
  ];

  while (pos < length) {
    const sub = source.slice(pos);
    let matched = false;

    for (const { type, regex } of regexes) {
      const m = regex.exec(sub);
      if (m && m.index === 0) {
        tokens.push({ type, value: m[0], position: pos });
        pos += m[0].length;
        matched = true;
        break;
      }
    }

    if (!matched) {
      // skip unknown char
      tokens.push({ type: 'symbol', value: source[pos], position: pos });
      pos++;
    }
  }

  return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}
