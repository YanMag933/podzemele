import http.server
import mimetypes
import os
import socket
import sys

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/javascript", ".js")
os.chdir(os.path.dirname(os.path.abspath(__file__)))


def phone_address():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.168.1.1", 80))
        return probe.getsockname()[0]
    except OSError:
        return ""
    finally:
        probe.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    try:
        server = http.server.ThreadingHTTPServer(("0.0.0.0", 8765), Handler)
    except OSError:
        print("Порт 8765 занят. Закройте другое окно счётчика и запустите снова.")
        return 1
    print("На этом компьютере: http://127.0.0.1:8765/")
    lan = phone_address()
    if lan and not lan.startswith("127."):
        print("С телефона в той же Wi-Fi: http://%s:8765/" % lan)
    print("Компьютер должен быть включён, а это окно — открыто.")
    print("Чтобы остановить, закройте это окно.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Остановлено.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
