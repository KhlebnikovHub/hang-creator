"""Локальный редактор табулатур: статика и JSON-файлы, без зависимостей."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
from pathlib import Path
import re
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import webbrowser


MAX_BODY_BYTES = 2 * 1024 * 1024
TAB_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")


class RequestError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def validate_tab(tab: object) -> dict:
    """Check the file envelope; musical validation belongs to the editor."""
    if not isinstance(tab, dict):
        raise RequestError(400, "Ожидается объект табулатуры JSON.")
    if tab.get("format") != "hang-tab" or type(tab.get("version")) is not int or tab["version"] != 1:
        raise RequestError(400, "Поддерживается формат hang-tab, версия 1.")
    if not isinstance(tab.get("id"), str) or not TAB_ID.fullmatch(tab["id"]):
        raise RequestError(400, "Некорректный ID табулатуры.")
    if not isinstance(tab.get("title"), str) or len(tab["title"]) > 400:
        raise RequestError(400, "Название должно быть строкой длиной до 400 символов.")
    measures = tab.get("measures")
    if not isinstance(measures, list) or len(measures) > 5000:
        raise RequestError(400, "Поле measures должно быть массивом длиной до 5000 элементов.")
    for measure in measures:
        if not isinstance(measure, dict):
            raise RequestError(400, "Каждый такт должен быть объектом.")
        if "rows" in measure:
            if not isinstance(measure["rows"], dict) or any(
                not isinstance(row, list) for row in measure["rows"].values()
            ):
                raise RequestError(400, "Дорожки такта должны быть массивами.")
    for key in ("subtitle", "notes", "notation", "hands"):
        if key in tab and not isinstance(tab[key], str):
            raise RequestError(400, f"Поле {key} должно быть строкой.")
    for key in ("beats", "phrases"):
        if key in tab and not isinstance(tab[key], list):
            raise RequestError(400, f"Поле {key} должно быть массивом.")
    if "tempo" in tab and (type(tab["tempo"]) not in (int, float) or not 1 <= tab["tempo"] <= 1000):
        raise RequestError(400, "Темп должен быть числом от 1 до 1000.")
    if "meter" in tab:
        meter = tab["meter"]
        if not isinstance(meter, dict) or any(
            type(meter.get(key)) is not int or not 1 <= meter[key] <= 128
            for key in ("numerator", "denominator")
        ):
            raise RequestError(400, "Размер должен содержать положительные numerator и denominator.")
    return tab


def _reject_constant(value: str):
    raise ValueError(f"Недопустимое значение JSON: {value}")


class TabServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, root: Path, port: int):
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("Папка приложения не найдена.")
        self.storage_lock = threading.RLock()
        super().__init__(("127.0.0.1", port), TabHandler)

    def tabs_directory(self, create: bool = False) -> Path:
        directory = self.root / "tabs"
        if directory.is_symlink():
            raise RequestError(400, "Папка tabs не должна быть символической ссылкой.")
        resolved = directory.resolve()
        if not resolved.is_relative_to(self.root):
            raise RequestError(400, "Недопустимый путь папки tabs.")
        if create:
            directory.mkdir(exist_ok=True)
        if directory.exists() and not directory.is_dir():
            raise RequestError(400, "Путь tabs должен быть папкой.")
        return directory

    def tab_path(self, tab_id: str, create_directory: bool = False) -> Path:
        if not TAB_ID.fullmatch(tab_id):
            raise RequestError(400, "Некорректный ID табулатуры.")
        directory = self.tabs_directory(create_directory)
        path = directory / f"{tab_id}.json"
        if path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
            raise RequestError(400, "Недопустимый путь табулатуры.")
        return path


class TabHandler(BaseHTTPRequestHandler):
    server: TabServer
    server_version = "HangLocal/1.0"

    def _headers(self, status: int, content_type: str, length: int):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()

    def _json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        if self.command != "HEAD":
            self.wfile.write(body)

    def _host(self) -> str:
        host = self.headers.get("Host", "")
        port = self.server.server_port
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            allowed.update(("127.0.0.1", "localhost"))
        if host.lower() not in allowed:
            raise RequestError(403, "Сервер доступен только через localhost или 127.0.0.1.")
        return host.lower()

    def _path(self) -> str:
        parsed = urlsplit(self.path)
        if parsed.scheme or parsed.netloc:
            raise RequestError(400, "Недопустимый путь запроса.")
        try:
            path = unquote(parsed.path, errors="strict")
        except UnicodeError:
            raise RequestError(400, "Некорректная кодировка пути.") from None
        if "\x00" in path or "\\" in path:
            raise RequestError(400, "Недопустимый путь запроса.")
        return path

    def _allow_mutation(self):
        host = self._host()
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            raise RequestError(403, "Изменения разрешены только из локального редактора.")
        origin = self.headers.get("Origin")
        if origin is not None and origin.lower() != f"http://{host}":
            raise RequestError(403, "Origin запроса не совпадает с адресом редактора.")

    def _run(self, callback):
        try:
            callback()
        except RequestError as error:
            self._json(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as error:
            self.log_error("Ошибка файловой системы: %s", error)
            self._json(500, {"error": "Не удалось прочитать или записать файл. Проверьте доступ к папке приложения."})
        except (ValueError, RecursionError):
            self._json(400, {"error": "Некорректный JSON или путь запроса."})

    def do_GET(self):
        self._run(self._get)

    def do_HEAD(self):
        self._run(self._get)

    def _get(self):
        self._host()
        path = self._path()
        if path == "/api/health":
            self._json(200, {"ok": True})
            return
        if path == "/api/tabs":
            tabs = []
            with self.server.storage_lock:
                directory = self.server.tabs_directory()
                if directory.exists():
                    for entry in sorted(directory.glob("*.json")):
                        if not TAB_ID.fullmatch(entry.stem):
                            continue
                        try:
                            entry = self.server.tab_path(entry.stem)
                            if not entry.is_file() or entry.stat().st_size > MAX_BODY_BYTES:
                                continue
                            tab = validate_tab(json.loads(entry.read_text(encoding="utf-8"), parse_constant=_reject_constant))
                            tabs.append(tab)
                        except (RequestError, ValueError, UnicodeError, RecursionError):
                            self.log_error("Пропущен некорректный файл: %s", entry.name)
            self._json(200, {"tabs": tabs})
            return
        if path.startswith("/api/"):
            raise RequestError(404, "API не найден.")
        parts = path.lstrip("/").split("/")
        if any(part.startswith(".") or ":" in part for part in parts if part):
            raise RequestError(403, "Недопустимый путь файла.")
        file_path = self.server.root.joinpath(*parts).resolve()
        if not file_path.is_relative_to(self.server.root):
            raise RequestError(403, "Файл находится за пределами папки приложения.")
        if file_path.is_dir():
            file_path = (file_path / "index.html").resolve()
        if not file_path.is_relative_to(self.server.root) or not file_path.is_file():
            raise RequestError(404, "Файл не найден.")
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.suffix.lower() in (".html", ".css", ".js", ".json", ".txt", ".md", ".svg"):
            content_type += "; charset=utf-8"
        self._headers(200, content_type, len(body))
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_POST(self):
        self._run(self._post)

    def _post(self):
        self._host()
        if self._path() != "/api/tabs":
            raise RequestError(404, "API не найден.")
        if self.headers.get("Transfer-Encoding"):
            raise RequestError(400, "Используйте Content-Length для JSON-запроса.")
        content_length = self.headers.get("Content-Length")
        if content_length is None:
            raise RequestError(411, "Не указан размер JSON-запроса.")
        try:
            length = int(content_length)
        except ValueError:
            raise RequestError(400, "Некорректный размер JSON-запроса.") from None
        if length < 1:
            raise RequestError(400, "Пустой JSON-запрос.")
        if length > MAX_BODY_BYTES:
            raise RequestError(413, "Размер табулатуры превышает 2 МБ.")
        self.connection.settimeout(15)
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            raise RequestError(408, "Истекло время ожидания JSON-запроса.") from None
        if len(body) != length:
            raise RequestError(400, "JSON-запрос получен не полностью.")
        # Consume the bounded request before returning an error. On Windows,
        # closing a socket with unread request bytes can reset the connection
        # before the browser receives the JSON error response.
        self._allow_mutation()
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "Ожидается Content-Type: application/json.")
        try:
            tab = validate_tab(json.loads(body.decode("utf-8"), parse_constant=_reject_constant))
        except (ValueError, UnicodeError, RecursionError):
            raise RequestError(400, "Не удалось прочитать JSON табулатуры.") from None
        encoded = (json.dumps(tab, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        if len(encoded) > MAX_BODY_BYTES:
            raise RequestError(413, "Размер файла табулатуры превышает 2 МБ.")
        with self.server.storage_lock:
            destination = self.server.tab_path(tab["id"], create_directory=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="wb", prefix=".save-", suffix=".tmp", dir=destination.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, destination)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        self._json(200, {"ok": True})

    def do_DELETE(self):
        self._run(self._delete)

    def _delete(self):
        self._allow_mutation()
        path = self._path()
        prefix = "/api/tabs/"
        if not path.startswith(prefix):
            raise RequestError(404, "API не найден.")
        with self.server.storage_lock:
            destination = self.server.tab_path(path[len(prefix):])
            destination.unlink(missing_ok=True)
        self._json(200, {"ok": True})


def create_server(root: str | Path, port: int = 0) -> TabServer:
    """Create a loopback-only server. Call serve_forever() to start it."""
    return TabServer(Path(root), port)


def main() -> int:
    parser = argparse.ArgumentParser(description="Локальный редактор табулатур ханга")
    parser.add_argument("--port", type=int, default=8765, help="Порт сервера (по умолчанию 8765)")
    parser.add_argument("--no-browser", action="store_true", help="Не открывать браузер автоматически")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("Порт должен быть числом от 0 до 65535.")
    try:
        server = create_server(Path(__file__).parent, args.port)
    except OSError as error:
        print(f"Не удалось запустить редактор: {error}")
        print("Возможно, порт занят. Попробуйте: python server.py --port 8766")
        return 1
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Редактор ханга: {url}")
    print(f"Табулатуры сохраняются в: {server.root / 'tabs'}")
    print("Оставьте это окно открытым. Для остановки нажмите Ctrl+C.")
    if not args.no_browser:
        timer = threading.Timer(0.3, webbrowser.open, args=(url,))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nРедактор остановлен.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
