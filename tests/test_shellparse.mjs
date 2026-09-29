// Тесты hooks/lib/shellparse.mjs — разбор команды Bash на сегменты и слова.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCommand } from '../hooks/lib/shellparse.mjs';

const words = (command) => parseCommand(command).segments.map((s) => s.words);

test('кавычки склеивают слово, пробелы внутри кавычек остаются', () => {
  assert.deepEqual(words('git p""ush'), [['git', 'push']]);
  assert.deepEqual(words(`g'i't -C "/tmp/a b" push`), [['git', '-C', '/tmp/a b', 'push']]);
  assert.deepEqual(words('echo a\\ b'), [['echo', 'a b']]);
});

test('разделители вне кавычек режут сегменты, внутри кавычек — нет', () => {
  assert.deepEqual(words('a && b || c; d | e'), [['a'], ['b'], ['c'], ['d'], ['e']]);
  assert.deepEqual(words('echo "a; b && c"'), [['echo', 'a; b && c']]);
  assert.deepEqual(words('a\nb'), [['a'], ['b']]);
});

test('подстановки $( ) и бэктики — отдельные сегменты', () => {
  assert.deepEqual(words('echo $(git status)'), [['echo'], ['git', 'status']]);
  assert.deepEqual(words('echo `ls`'), [['echo'], ['ls']]);
});

test('тело heredoc — данные сегмента, а не слова', () => {
  const parsed = parseCommand('cat <<EOF\nline one\nline two\nEOF\nls');
  assert.equal(parsed.segments[0].words[0], 'cat');
  assert.deepEqual(parsed.segments[0].heredocs, ['line one\nline two']);
  assert.deepEqual(parsed.segments[1].words, ['ls']);
});

test('heredoc с тире срезает ведущие табы у разделителя', () => {
  const parsed = parseCommand('cat <<-EOF\n\tbody\n\tEOF\n');
  assert.deepEqual(parsed.segments[0].heredocs, ['\tbody']);
});

test('незакрытая кавычка — null, пустая команда — без сегментов', () => {
  assert.equal(parseCommand('echo "oops'), null);
  assert.equal(parseCommand("echo 'oops"), null);
  assert.deepEqual(parseCommand('').segments, []);
});
