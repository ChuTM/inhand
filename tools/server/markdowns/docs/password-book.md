# Password Book

The **Password Book** is the teacher's local, encrypted list of student Mac passwords — used when a client needs `sudo` to finish an update or a repair that the automatic flow cannot complete.

## Why it exists

Student clients install and update without root. A few maintenance actions — installing the firewall helper, repairing a partial update — still require an administrator password on the student's own machine. The Password Book lets the teacher supply that password without interrupting the lesson: the client asks the host for help, and the teacher's machine answers from its book.

## Format

Each line is one machine:

```
host-name:password
```

- One entry per line: the host name, a colon, then the password.
- Blank lines and lines starting with `#` are ignored.

## How to use it

1. In the Admin console, open **Actions → Password Book**.
2. **Import** a file, or **edit** the book directly in the page.
3. Save — the book is encrypted and stored locally on the teacher's Mac.

## Security

- The book is encrypted at rest with your **unlock password** — it is decrypted only in memory while the admin app is unlocked.
- It never leaves the teacher's machine.
- Passwords are used one at a time, for the exact host that requested help; they are never broadcast across the classroom.
