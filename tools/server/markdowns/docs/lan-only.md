# LAN Only Mode

**LAN Only Mode** is a one-click way to restrict a student device to the classroom network: the Mac keeps working on the school LAN, but its internet access is cut off at the firewall. It is a focus tool — for a test, a presentation, or any activity that should not be reaching the wider web.

## What it does

- **Blocks the internet** on the selected student devices — browsing, streaming, downloads and cloud calls all stop.
- **Keeps the LAN alive** — students can still reach the teacher, file shares and other devices on the school network, and the teacher can still view and control the session.
- **Sets a deadline** — the teacher picks how long the restriction lasts, or leaves it on until it is manually released.

## How to use it (teacher)

1. Open the Admin console and unlock it with your password.
2. In **Actions**, click the **lan-only** tile.
3. Choose a duration — or leave it open-ended — then confirm the action.
4. Release it at any time with the same tile.

> If the teacher's panel is ever unavailable, the school's IT can release a single machine manually with `sudo sh inhand-fwctl unlock`.

## What the student sees

The student gets a small, discreet pill in the top-right corner of the screen — **Restricted to LAN Only.** — with no dialogs and no system notifications. It reads like a system status indicator, so nothing distracts from the lesson.

## Notes & safety

- The restriction is enforced by a **root-owned firewall daemon** installed by the official installer — students cannot remove it.
- LAN Only Mode only gates network access; it never touches files, wallpapers or accounts.
- The teacher can re-lock at any time; the daemon stays loaded and ready.
