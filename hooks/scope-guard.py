#!/usr/bin/python3
"""PreToolUse-хук (Edit|Write|NotebookEdit) для агентов-исполнителей комплекта.

Правка файла вне области агента блокируется, а не «не рекомендуется»: словесная
инструкция в промпте — контекст, а этот скрипт — проверка перед записью.
Семантика Claude Code: exit 2 отменяет вызов, stderr уходит агенту; ЛЮБОЙ
другой код, падение или таймаут — «неблокирующая ошибка», запись проходит.
Поэтому каждый нештатный путь здесь обязан закончиться exit 2 (fail-closed),
а строка запуска во frontmatter добавляет `|| exit 2` на случай, если сам
интерпретатор не запустился. Модель угроз и остаточные риски (TOCTOU, Bash,
таймаут хоста) — в hooks/SECURITY-hooks.md.

Область не задаётся окружением. Корень кода и id проекта — из
`$HOME/.agent-kit/current/bin/collab project --json` (cwd — из события),
допустимые пути — из доверенного реестра `<registryDir>/<projectId>/scopes.json`
по имени агента (`KIT_AGENT` из frontmatter). Переопределений пути к collab нет.

Порядок проверок:
  0. Событие: tool_name ∈ {Edit, Write, NotebookEdit}; поле пути соответствует
     инструменту и не задано дважды; cwd есть и абсолютный; в строках нет NUL
     и непредставимых в UTF-8 символов.
  1. Жёсткий запрет по лексическому абсолютному пути И по realpath:
     ~/agent-kit, ~/.agent-kit, ~/.claude, ~/.codex (от $HOME и от домашнего
     каталога из passwd).
  2. /tmp, /private/tmp — разрешены, только если оба пути под ними, в пути нет
     .git/.claude/.collab/.mcp.json и цель НЕ внутри git-репозитория (git по
     абсолютному пути, окружение без GIT_*). Иначе — обычные правила проекта.
  3. collab project --json (таймаут 5 с, своя группа процессов) — любая ошибка
     блокирует.
  4. Цель (realpath) внутри realpath(codeRoot).
  5. .git, .claude, .collab, .mcp.json как компонент где угодно внутри корня.
  6–7. projectId/registryDir валидны, scopes.json читается, есть запись агента,
     allow/deny — списки непустых строк без `..`.
  8. deny по границе компонента — блок; 9. нет allow — блок.

Все компоненты путей и шаблонов сравниваются после NFC + casefold(): том
нечувствителен к регистру и нормализации, а realpath сохраняет написание
вызывающего, так что `App/claude.md` и `App/CLAUDE.md` — один файл.
"""
import json
import os
import pwd
import re
import signal
import stat
import subprocess
import sys
import unicodedata

FIXED_PATH = "/usr/bin:/bin:/opt/homebrew/bin"
COLLAB_TIMEOUT_SECONDS = 5
GIT_TIMEOUT_SECONDS = 3
# Сторож на весь хук: collab (5) + git (3) укладываются, а таймаут хука во
# frontmatter — 15 с. Сработал сторож — exit 2, а не убийство хостом (= пропуск).
WATCHDOG_SECONDS = 10

GIT_CANDIDATES = ("/usr/bin/git", "/opt/homebrew/bin/git")
GIT_NOT_A_REPO = b"not a git repository (or any of the parent directories)"

TOOL_PATH_FIELD = {"Edit": "file_path", "Write": "file_path", "NotebookEdit": "notebook_path"}
PATH_FIELDS = ("file_path", "notebook_path")

# Каталоги комплекта и глобальных настроек Claude/Codex — никогда не
# редактируются агентами, независимо от scopes.json какого-либо проекта.
PROTECTED_HOME_DIRS = ("agent-kit", ".agent-kit", ".claude", ".codex")
TMP_ROOTS = ("/tmp", "/private/tmp")
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

_ACTIVE_CHILDREN = []


class Blocked(Exception):
    """Проверка не пройдена — сообщение уходит агенту, exit 2."""


class WatchdogFired(BaseException):
    pass


def fold(text):
    """Каноническая форма для сравнения: NFC(casefold(NFD(x)))."""
    return unicodedata.normalize("NFC", unicodedata.normalize("NFD", text).casefold())


HARD_DENY_NAMES = frozenset(fold(n) for n in (".git", ".claude", ".collab", ".mcp.json"))


def emit(message):
    try:
        data = f"scope-guard: {message}\n".encode("utf-8", "backslashreplace")
        sys.stderr.buffer.write(data)
        sys.stderr.buffer.flush()
    except BaseException:  # noqa: BLE001 - сообщение не критично, код выхода — да
        pass


def safe_str(value, what):
    if not isinstance(value, str) or not value:
        raise Blocked(f"{what}: ожидалась непустая строка — блокирую")
    if "\x00" in value:
        raise Blocked(f"{what} содержит NUL-байт — блокирую")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise Blocked(f"{what} содержит символы, непредставимые в UTF-8 — блокирую")
    return value


def safe_abs(value, what):
    safe_str(value, what)
    if not os.path.isabs(value):
        raise Blocked(f"{what} должен быть абсолютным путём, получено {value!r} — блокирую")
    return value


def raw_parts(path):
    return [p for p in path.split("/") if p not in ("", ".")]


def folded_parts(path):
    return [fold(p) for p in raw_parts(path)]


def is_under(path_parts, root_parts):
    return path_parts[: len(root_parts)] == root_parts


def run_capped(argv, cwd, env, timeout):
    """subprocess с таймаутом, убивающим всю группу процессов (включая внуков,
    которые держат stdout открытым)."""
    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        close_fds=True,
    )
    _ACTIVE_CHILDREN.append(proc)
    try:
        out, err = proc.communicate(timeout=timeout)
    finally:
        kill_group(proc)
        _ACTIVE_CHILDREN.remove(proc)
    return proc.returncode, out, err


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    if proc.returncode is None:
        try:
            proc.wait(timeout=1)
        except BaseException:  # noqa: BLE001
            pass


def existing_parent(path):
    current = os.path.dirname(path)
    while current and not os.path.isdir(current):
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return current or "/"


def maybe_inside_git_repo(real_target, home):
    """True — внутри репозитория ИЛИ не удалось надёжно выяснить."""
    git = next((g for g in GIT_CANDIDATES if os.path.isfile(g) and os.access(g, os.X_OK)), None)
    if git is None:
        return True
    env = {"PATH": FIXED_PATH, "HOME": home, "LC_ALL": "C", "LANG": "C"}
    try:
        rc, _out, err = run_capped(
            [git, "rev-parse", "--absolute-git-dir"], existing_parent(real_target), env, GIT_TIMEOUT_SECONDS
        )
    except (OSError, subprocess.SubprocessError):
        return True
    if rc == 128 and GIT_NOT_A_REPO in (err or b""):
        return False
    return True


def load_event():
    try:
        raw = sys.stdin.buffer.read()
    except OSError as exc:
        raise Blocked(f"не удалось прочитать событие хука: {exc}")
    if not raw.strip():
        raise Blocked("пустое событие хука — блокирую на всякий случай")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise Blocked("событие хука не в UTF-8 — блокирую на всякий случай")
    try:
        event = json.loads(text)
    except ValueError:
        raise Blocked("событие хука пришло не в формате JSON — блокирую на всякий случай")
    if not isinstance(event, dict):
        raise Blocked("событие хука имеет неожиданный формат (не объект) — блокирую на всякий случай")
    return event


def parse_patterns(value, key, scopes_path):
    if value is None:
        return []
    if not isinstance(value, list):
        raise Blocked(f"{scopes_path}: «{key}» должен быть списком строк — блокирую")
    patterns = []
    for item in value:
        if not isinstance(item, str) or "\x00" in item:
            raise Blocked(f"{scopes_path}: в «{key}» некорректный элемент {item!r} — блокирую")
        parts = folded_parts(item)
        if not parts or ".." in parts:
            raise Blocked(f"{scopes_path}: в «{key}» некорректный шаблон {item!r} — блокирую")
        patterns.append(parts)
    return patterns


def decide():
    home = safe_abs(os.environ.get("HOME"), "HOME")
    event = load_event()

    # 0. Событие.
    tool = event.get("tool_name")
    if not isinstance(tool, str) or tool not in TOOL_PATH_FIELD:
        raise Blocked(f"неожиданный tool_name {tool!r} — хук подключён только к Edit|Write|NotebookEdit, блокирую")
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        raise Blocked("в событии нет объекта tool_input — блокирую")
    present = [f for f in PATH_FIELDS if f in tool_input]
    if len(present) > 1:
        raise Blocked("в событии одновременно file_path и notebook_path — неоднозначно, блокирую")
    field = TOOL_PATH_FIELD[tool]
    if present != [field]:
        raise Blocked(f"для {tool} ожидалось поле {field}, получено {present or 'ничего'} — блокирую")
    path = safe_str(tool_input[field], field)
    cwd = safe_abs(event.get("cwd"), "cwd события")

    joined = path if os.path.isabs(path) else os.path.join(cwd, path)
    lexical = os.path.normpath(joined)
    real = os.path.realpath(joined)
    candidates = [folded_parts(lexical), folded_parts(real)]

    # 1. Защищённые каталоги — по обоим путям и по обоим написаниям корня.
    bases = {home}
    bases.add(pwd.getpwuid(os.getuid()).pw_dir)
    for base in sorted(bases):
        for name in PROTECTED_HOME_DIRS:
            root_lex = os.path.normpath(os.path.join(base, name))
            for root in {root_lex, os.path.realpath(root_lex)}:
                root_parts = folded_parts(root)
                if any(is_under(c, root_parts) for c in candidates):
                    raise Blocked(
                        f"{real} внутри защищённого каталога ({root}) — эти файлы "
                        "не редактируются агентами ни при каком scopes.json"
                    )

    # 1б. Цель — обычный файл с единственным именем или ещё не существует.
    #     Жёсткая ссылка — второе имя того же inode: правка по «разрешённому»
    #     имени меняет и файл вне области, а имена и realpath этого не видят.
    #     Доказать, что второе имя тоже в области, дёшево нельзя — блокируем всегда.
    try:
        st = os.lstat(real)
    except FileNotFoundError:
        try:
            os.lstat(joined)
        except FileNotFoundError:
            st = None  # новый файл — как раньше
        except OSError as exc:
            raise Blocked(f"не удалось проверить {joined}: {exc} — блокирую")
        else:
            raise Blocked(f"{joined} — висячая символическая ссылка, неясно, что будет создано — блокирую")
    except OSError as exc:
        raise Blocked(f"не удалось проверить {real}: {exc} — блокирую")
    if st is not None:
        if not stat.S_ISREG(st.st_mode):
            raise Blocked(f"{real} — не обычный файл (каталог, FIFO, устройство, сокет или ссылка) — блокирую")
        if st.st_nlink > 1:
            raise Blocked(
                f"{real}: у файла {st.st_nlink} имени (жёсткие ссылки) — правка изменила бы и другие имена "
                "того же файла, возможно вне области; блокирую"
            )

    # 2. Исключение для /tmp — только вне git-репозиториев и без служебных имён.
    tmp_roots = [folded_parts(t) for t in TMP_ROOTS]
    both_in_tmp = all(any(is_under(c, t) for t in tmp_roots) for c in candidates)
    has_service_name = any(part in HARD_DENY_NAMES for c in candidates for part in c)
    if both_in_tmp and not has_service_name and not maybe_inside_git_repo(real, home):
        return 0

    # 3. collab project --json — единственный путь, без переопределений.
    collab_bin = os.path.join(home, ".agent-kit", "current", "bin", "collab")
    try:
        rc, out, err = run_capped(
            [collab_bin, "project", "--json"], cwd, {"PATH": FIXED_PATH, "HOME": home}, COLLAB_TIMEOUT_SECONDS
        )
    except subprocess.TimeoutExpired:
        raise Blocked(f"collab project --json не ответил за {COLLAB_TIMEOUT_SECONDS} с — блокирую")
    except OSError as exc:
        raise Blocked(f"не удалось запустить {collab_bin}: {exc} — блокирую")
    if rc != 0:
        detail = (err or b"").decode("utf-8", "backslashreplace").strip()[:300]
        raise Blocked(f"collab project --json завершился с кодом {rc} — блокирую ({detail})")
    try:
        info = json.loads(out.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Blocked("collab project --json вернул не JSON в UTF-8 — блокирую")
    if not isinstance(info, dict):
        raise Blocked("collab project --json вернул неожиданный формат (не объект) — блокирую")
    if info.get("error"):
        raise Blocked(f"collab project --json сообщил об ошибке: {info['error']} — блокирую")

    code_root = info.get("codeRoot")
    if code_root is None:
        raise Blocked("collab project --json не сообщил codeRoot — блокирую")
    code_root = safe_abs(code_root, "codeRoot")
    root_real = os.path.realpath(code_root)
    root_real_parts = folded_parts(root_real)

    # 4. Цель внутри корня кода (по realpath).
    real_parts = candidates[1]
    if not is_under(real_parts, root_real_parts):
        raise Blocked(f"{real} вне корня кода проекта ({root_real}) — блокирую")
    rel_forms = [real_parts[len(root_real_parts):]]
    display = "/".join(raw_parts(real)[len(root_real_parts):])
    for root in {os.path.normpath(code_root), root_real}:
        root_parts = folded_parts(root)
        if is_under(candidates[0], root_parts):
            rel_forms.append(candidates[0][len(root_parts):])
            break
    if any(not rel for rel in rel_forms):
        raise Blocked(f"{real} совпадает с корнем кода — блокирую")

    # 5. Служебные имена где угодно внутри корня.
    if any(part in HARD_DENY_NAMES for rel in rel_forms for part in rel):
        raise Blocked(f"{display} — служебный путь (.git/.claude/.collab/.mcp.json), агенты его не трогают ни при каком allow")

    # 6. Проект в реестре.
    project_id = info.get("projectId")
    if not project_id:
        raise Blocked(
            "проект не описан в реестре — владелец должен зарегистрировать его в "
            "~/agent-kit/projects/<id>/project.json"
        )
    if not isinstance(project_id, str) or not PROJECT_ID_RE.match(project_id):
        raise Blocked(f"collab project --json вернул некорректный projectId {project_id!r} — блокирую")
    registry_dir = info.get("registryDir")
    if registry_dir is None:
        raise Blocked("collab project --json не сообщил registryDir — блокирую")
    registry_dir = safe_abs(registry_dir, "registryDir")

    # 7. scopes.json.
    scopes_path = os.path.join(registry_dir, project_id, "scopes.json")
    try:
        with open(scopes_path, "rb") as fh:
            scopes = json.loads(fh.read().decode("utf-8"))
    except FileNotFoundError:
        raise Blocked(
            f"нет {scopes_path} — владелец должен описать области в "
            f"~/agent-kit/projects/{project_id}/scopes.json"
        )
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise Blocked(f"не удалось прочитать {scopes_path}: {exc} — блокирую")
    if not isinstance(scopes, dict):
        raise Blocked(f"{scopes_path} имеет неожиданный формат (не объект) — блокирую")

    agent = os.environ.get("KIT_AGENT")
    if not agent:
        raise Blocked("не задан KIT_AGENT в команде хука — не знаю, чьи области проверять, блокирую")
    agent_scopes = scopes.get(agent)
    if not isinstance(agent_scopes, dict):
        raise Blocked(
            f"для агента «{agent}» нет описанных областей в {scopes_path} — "
            "владелец должен их добавить"
        )
    allow = parse_patterns(agent_scopes.get("allow"), "allow", scopes_path)
    deny = parse_patterns(agent_scopes.get("deny"), "deny", scopes_path)

    # 8. deny — по границе компонента, по любой форме пути.
    if any(is_under(rel, p) for rel in rel_forms for p in deny):
        raise Blocked(f"{display} запрещён явно для «{agent}» (deny в {scopes_path})")

    # 9. allow — каждая форма пути обязана попасть под allow.
    if not all(any(is_under(rel, p) for p in allow) for rel in rel_forms):
        shown = agent_scopes.get("allow") or "[]"
        raise Blocked(f"{display} вне разрешённых областей «{agent}» (allow: {shown})")

    return 0


def _on_alarm(signum, frame):
    raise WatchdogFired()


def entrypoint():
    code = 2
    try:
        signal.signal(signal.SIGALRM, _on_alarm)
        signal.alarm(WATCHDOG_SECONDS)
        try:
            result = decide()
            code = 0 if (type(result) is int and result == 0) else 2
        except Blocked as exc:
            emit(str(exc))
            code = 2
        finally:
            signal.alarm(0)
    except WatchdogFired:
        emit(f"проверка не уложилась в {WATCHDOG_SECONDS} с — правка заблокирована на всякий случай")
        code = 2
    except BaseException as exc:  # noqa: BLE001 - любой сбой = блок
        emit(f"внутренняя ошибка хука ({type(exc).__name__}) — правка заблокирована на всякий случай")
        code = 2
    finally:
        for child in list(_ACTIVE_CHILDREN):
            kill_group(child)
    os._exit(code)


if __name__ == "__main__":
    entrypoint()
