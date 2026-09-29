// Разбор команды Bash на сегменты и слова — ровно настолько, чтобы отличить «запускается git push» от
// «текст, в котором встречается git push» (echo, heredoc, аргумент git commit -m). Кавычки и `\`-экранирование
// по правилам POSIX-оболочки; Git Bash на Windows разбирает так же. Не оболочка: переменные, глоббинг и
// alias из конфигурации пользователя не раскрываются.
//
// Возвращает { segments: [{ words, heredocs }] } или null, если команда не разобрана (незакрытая кавычка).
// Разделители вне кавычек: `; & | && || \n ( ) ` $(` — граница сегмента. Тела heredoc не слова, а данные:
// они отдаются отдельно в `heredocs` сегмента, чтобы `bash <<EOF … EOF` можно было проверить как код.

const OPERATOR_CHARS = new Set([';', '&', '|', '(', ')', '`', '<', '>']);

export function parseCommand(command) {
  const segments = [];
  let words = [];
  let heredocs = [];
  let word = null;
  let quote = null;
  const pendingHeredocs = [];

  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length || heredocs.length) segments.push({ words, heredocs });
    words = [];
    heredocs = [];
  };
  const readHeredocBodies = (from) => {
    let pos = from;
    for (const spec of pendingHeredocs.splice(0)) {
      const lines = [];
      let closed = false;
      while (pos <= command.length) {
        const nl = command.indexOf('\n', pos);
        const raw = nl === -1 ? command.slice(pos) : command.slice(pos, nl);
        pos = nl === -1 ? command.length + 1 : nl + 1;
        const line = spec.strip ? raw.replace(/^\t+/, '') : raw;
        if (line === spec.delimiter) {
          closed = true;
          break;
        }
        lines.push(raw);
        if (nl === -1) break;
      }
      if (!closed && lines.length === 0) continue;
      heredocs.push(lines.join('\n'));
    }
    return pos;
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === '\\' && '"\\$`\n'.includes(command[i + 1] ?? '')) {
        if (command[i + 1] !== '\n') word += command[i + 1];
        i += 1;
      } else {
        word += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
      i += 1;
    } else if (ch === '\\') {
      if (i + 1 < command.length) {
        if (command[i + 1] !== '\n') word = (word ?? '') + command[i + 1];
        i += 2;
      } else {
        i += 1;
      }
    } else if (ch === '\n') {
      i = pendingHeredocs.length ? readHeredocBodies(i + 1) : i + 1;
      endSegment();
    } else if (ch === '$' && command[i + 1] === '(') {
      endSegment();
      i += 2;
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      endWord();
      let j = i + 2;
      const strip = command[j] === '-';
      if (strip) j += 1;
      while (command[j] === ' ' || command[j] === '\t') j += 1;
      let delimiter = '';
      let dq = null;
      while (j < command.length) {
        const c = command[j];
        if (dq) {
          if (c === dq) dq = null;
          else delimiter += c;
        } else if (c === '"' || c === "'") dq = c;
        else if (/\s/.test(c) || OPERATOR_CHARS.has(c)) break;
        else delimiter += c;
        j += 1;
      }
      if (delimiter) pendingHeredocs.push({ delimiter, strip });
      i = j;
    } else if (OPERATOR_CHARS.has(ch)) {
      if (ch === '<' || ch === '>') endWord();
      else endSegment();
      i += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
      i += 1;
    } else {
      word = (word ?? '') + ch;
      i += 1;
    }
  }
  if (quote) return null;
  if (pendingHeredocs.length) readHeredocBodies(command.length + 1);
  endSegment();
  return { segments };
}
