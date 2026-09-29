// Разбор команды Bash на сегменты и слова — ровно настолько, чтобы отличить «запускается git push» от
// «текст, в котором встречается git push» (echo, heredoc, аргумент git commit -m). Кавычки и `\`-экранирование
// по правилам POSIX-оболочки; Git Bash на Windows разбирает так же. Не оболочка: переменные, глоббинг и
// alias из конфигурации пользователя не раскрываются.
//
// Возвращает { segments: [{ words, heredocs, heredocSubs, subs }] } или null, если команда не разобрана
// (незакрытая кавычка). Разделители вне кавычек: `; & | && || \n ( ) ` $(` — граница сегмента.
//   words       — слова программы; операнды перенаправлений (`> файл`, `2>&1`) в них не попадают;
//   heredocs    — тела heredoc и here-string (`<<<`): данные, но `bash <<EOF … EOF` — это код;
//   heredocSubs — подстановки `$(…)`/бэктики из тел heredoc с нецитированным разделителем: они исполняются;
//   subs        — подстановки внутри двойных кавычек (`echo "$(cmd)"`): тоже исполняются.
// `#` в начале слова — комментарий до конца строки.

const OPERATOR_CHARS = new Set([';', '&', '|', '(', ')', '`', '<', '>']);

// Текст после открывающей `(` до парной `)` — с учётом вложенных скобок, кавычек и `\`.
function scanParen(text, from) {
  let depth = 1;
  let quote = null;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '\\') i += 1;
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { body: text.slice(from, i), end: i + 1 };
  }
  return { body: text.slice(from), end: text.length };
}

function scanBacktick(text, from) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '`') return { body: text.slice(from, i), end: i + 1 };
  }
  return { body: text.slice(from), end: text.length };
}

// Подстановки `$(…)` и `` `…` `` в тексте (неэкранированные): то, что оболочка исполнит внутри двойных кавычек
// или тела heredoc с нецитированным разделителем.
export function commandSubstitutions(text) {
  const found = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '$' && text[i + 1] === '(') {
      const { body, end } = scanParen(text, i + 2);
      found.push(body);
      i = end;
    } else if (ch === '`') {
      const { body, end } = scanBacktick(text, i + 1);
      found.push(body);
      i = end;
    } else {
      i += 1;
    }
  }
  return found;
}

export function parseCommand(command) {
  const segments = [];
  let words = [];
  let heredocs = [];
  let heredocSubs = [];
  let subs = [];
  let word = null;
  let quote = null;
  let nextWord = null; // 'skip' — операнд перенаправления; 'here' — here-string
  const pendingHeredocs = [];

  const endWord = () => {
    if (word !== null) {
      if (nextWord === 'skip') {
        // операнд перенаправления — не слово программы
      } else if (nextWord === 'here') {
        heredocs.push(word);
        heredocSubs.push(...commandSubstitutions(word));
      } else {
        words.push(word);
      }
      nextWord = null;
    }
    word = null;
  };
  const endSegment = () => {
    endWord();
    nextWord = null;
    if (words.length || heredocs.length || subs.length || heredocSubs.length) segments.push({ words, heredocs, heredocSubs, subs });
    words = [];
    heredocs = [];
    heredocSubs = [];
    subs = [];
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
      const body = lines.join('\n');
      heredocs.push(body);
      if (spec.expands) heredocSubs.push(...commandSubstitutions(body));
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
      } else if (quote === '"' && ch === '$' && command[i + 1] === '(') {
        const { body } = scanParen(command, i + 2);
        subs.push(body);
        word += ch;
      } else if (quote === '"' && ch === '`') {
        const { body } = scanBacktick(command, i + 1);
        subs.push(body);
        word += ch;
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
    } else if (ch === '#' && word === null) {
      while (i < command.length && command[i] !== '\n') i += 1;
    } else if (ch === '\n') {
      i = pendingHeredocs.length ? readHeredocBodies(i + 1) : i + 1;
      endSegment();
    } else if (ch === '$' && command[i + 1] === '(') {
      endSegment();
      i += 2;
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] === '<') {
      endWord();
      nextWord = 'here';
      i += 3;
    } else if (ch === '<' && command[i + 1] === '<') {
      endWord();
      let j = i + 2;
      const strip = command[j] === '-';
      if (strip) j += 1;
      while (command[j] === ' ' || command[j] === '\t') j += 1;
      let delimiter = '';
      let dq = null;
      let expands = true;
      while (j < command.length) {
        const c = command[j];
        if (dq) {
          if (c === dq) dq = null;
          else delimiter += c;
        } else if (c === '"' || c === "'") {
          dq = c;
          expands = false;
        } else if (c === '\\' && j + 1 < command.length) {
          expands = false;
          delimiter += command[j + 1];
          j += 1;
        } else if (/\s/.test(c) || OPERATOR_CHARS.has(c)) break;
        else delimiter += c;
        j += 1;
      }
      if (delimiter) pendingHeredocs.push({ delimiter, strip, expands });
      i = j;
    } else if (ch === '&' && command[i + 1] === '>') {
      i += 1; // `&>` и `&>>` — перенаправление, а не конец команды
    } else if (ch === '<' || ch === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null; // `2>файл`: цифры — номер дескриптора
      endWord();
      i += 1;
      if (command[i] === '(') continue; // подстановка процесса `<(…)`: скобку разберёт основной цикл
      if (command[i] === '>' || command[i] === '|' || command[i] === '&' || (ch === '<' && command[i] === '>')) i += 1;
      nextWord = 'skip';
    } else if (OPERATOR_CHARS.has(ch)) {
      endSegment();
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
