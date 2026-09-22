# Classroom Guide

A practical walkthrough of running a lesson with InHand — from starting a share to ending the session.

## Before the lesson

1. Open the **teacher app** and confirm every student client shows **Connected**.
2. If a machine is missing, check the student installed the client (see [Installing the Student Client](student-install.md)) and that it is on the same network.
3. Have the material ready on your screen — a document, slides or a live demo.

## During the lesson

![What a student sees while the teacher shares](/images/docs/student-share.png)

### Start sharing

1. Click **Share screen** in the teacher console.
2. Pick the window or display to share.
3. Every student device displays the shared content on their class wall.

> Sharing is **teacher-controlled** at all times — you choose what is shown. The class can only see what you explicitly share.

### Use Focus mode

To bring every student device to the same screen:

1. Click **Focus mode** in the teacher console.
2. All student walls lock to the shared content — no distractions, no tabbing away.
3. Click **Exit focus** to release the class.

### Cut internet access (optional)

If your school installed the LAN-only firewall helper, the teacher can cut internet access for the class while keeping the LAN working — useful for tests or exams. Click the firewall toggle in the console. To force-close a locked machine: `sudo sh /Library/Application Support/InHand/inhand-fwctl unlock`.

## After the lesson

1. Click **End session** in the teacher console.
2. Student devices return to their normal state automatically.
3. The audit log records the session for your records.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| A student shows *Offline* | Verify the student client is running (LaunchAgent `com.inhand.student`), and that the machine is on the school LAN. |
| Screen sharing is greyed out | Grant **Screen Recording** permission to the teacher app in System Settings → Privacy & Security. |
| Students see a blank wall | End the session and start a new share; check you selected the correct window. |
| School not discovered | Re-run registration with a fresh token; one public IP is one registration. |
