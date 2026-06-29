#!/usr/bin/env python3
"""List recent INBOX + Spam messages by subject substring."""
import imaplib, os, sys, email
from email.header import decode_header

m = imaplib.IMAP4_SSL(os.environ["IMAP_HOST"], int(os.environ["IMAP_PORT"]))
m.login(os.environ["IMAP_USER"], os.environ["IMAP_PASSWORD"])
needle = os.environ.get("SUBJECT_NEEDLE", "")

for folder in ["INBOX", "spam"]:
    print(f"\n=== {folder} ===")
    try:
        m.select(f'"{folder}"', readonly=True)
        typ, data = m.search(None, "ALL")
        ids = data[0].split()[-30:]
        for i in ids:
            typ, msg_data = m.fetch(i, "(BODY[HEADER.FIELDS (Message-ID Subject Date From)])")
            if typ != "OK": continue
            raw = msg_data[0][1].decode("utf-8", errors="replace")
            msg = email.message_from_string(raw)
            subj_raw = msg.get("Subject", "")
            parts = decode_header(subj_raw)
            subj = ""
            for p, enc in parts:
                if isinstance(p, bytes):
                    subj += p.decode(enc or "utf-8", errors="replace")
                else:
                    subj += p
            if needle and needle.lower() not in subj.lower():
                continue
            mid = msg.get("Message-ID", "")
            date = msg.get("Date", "")
            sender = msg.get("From", "")[:30]
            print(f"{date} | from={sender} | mid={mid[:35]} | subj={subj[:50]}")
    except Exception as e:
        print(f"  error: {e}")
m.logout()
