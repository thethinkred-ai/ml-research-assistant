#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Загрузка статики «Методологического ассистента» на thinkred.ru по FTP.

Запускается из GitHub Actions (site-deploy.yml): локальная сеть часто режет
исходящие 21/22, раннер — нет. Аналог tools/ftp_upload.py: только upload,
перед перезаписью удалённый файл скачивается в backup/ (попадает в артефакт
записа). Учётные данные — только из env (FTP_HOSTS, FTP_USER, FTP_PASS),
в логи не печатаются.

Использование: python scripts/ftp_deploy.py <локальный каталог> <удалённый каталог>
Пример:        python scripts/ftp_deploy.py frontend /assistant
"""
import sys
import os
import datetime as dt
from ftplib import FTP
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

LOCAL_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("frontend")
REMOTE_DIR = (sys.argv[2] if len(sys.argv) > 2 else "/assistant").rstrip("/")
BACKUP_DIR = Path("backup")
HOSTS = [h.strip() for h in os.environ.get("FTP_HOSTS", "").split(",") if h.strip()]
USER = os.environ.get("FTP_USER", "")
PWD = os.environ.get("FTP_PASS", "")

if not (HOSTS and USER and PWD):
    raise SystemExit("FTP_HOSTS / FTP_USER / FTP_PASS не заданы (env)")
if not LOCAL_DIR.is_dir():
    raise SystemExit(f"нет локального каталога: {LOCAL_DIR}")


def connect():
    last = None
    for host in HOSTS:
        try:
            ftp = FTP()
            ftp.connect(host, 21, timeout=60)
            ftp.login(USER, PWD)
            ftp.set_pasv(True)
            print(f"подключились: {host}")
            return ftp
        except Exception as e:
            print(f"{host}: недоступен ({type(e).__name__}: {e})")
            last = e
    raise SystemExit(f"FTP недоступен ни на одном хосте: {type(last).__name__}")


def ensure_dir(ftp, path):
    parts = [p for p in path.split("/") if p]
    cur = ""
    for p in parts:
        cur += "/" + p
        try:
            ftp.mkd(cur)
            print(f"создан каталог {cur}")
        except Exception:
            pass  # уже существует


def main():
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    ftp = connect()

    try:
        ftp.retrlines(f"LIST {REMOTE_DIR}")
    except Exception as e:
        print(f"{REMOTE_DIR} отсутствует, создаю ({type(e).__name__})")
        ensure_dir(ftp, REMOTE_DIR)

    files = sorted(p for p in LOCAL_DIR.iterdir() if p.is_file())
    print(f"к загрузке: {[p.name for p in files]}")
    failed = []
    for lp in files:
        remote = f"{REMOTE_DIR}/{lp.name}"
        BACKUP_DIR.mkdir(exist_ok=True)
        bak = BACKUP_DIR / f"{stamp}-{lp.name}"
        try:
            ftp.retrbinary(f"RETR {remote}", bak.open("wb").write)
            print(f"бэкап: {bak.name} ({bak.stat().st_size} байт)")
        except Exception:
            print(f"бэкап: {remote} на сервере нет — пропущено")
        ensure_dir(ftp, REMOTE_DIR)
        with open(lp, "rb") as f:
            ftp.storbinary(f"STOR {remote}", f)
        size = ftp.size(remote)
        ok = size == lp.stat().st_size
        print(f"загружен {remote}: {size} байт [{'ok' if ok else 'РАЗМЕР СБОЙ'}]")
        if not ok:
            failed.append(lp.name)
    ftp.quit()
    if failed:
        raise SystemExit(f"сбой размера у: {failed}")
    print("готово")


if __name__ == "__main__":
    main()
