# Teacher Setup Guide

Set up the InHand teacher app and admin console so you can register your school, manage students and share your screen in class.

![The InHand teacher app — live client list, screen sharing and command controls](/images/docs/teacher-console.png)

## 1. Sign in

1. Open the **InHand teacher app** on your Mac.
2. Choose **Sign in with Google** or **Sign in with a passkey** — the same account you use for the admin console.
3. The app connects to the cloud, discovers your school and loads your class list.

> The first admin in your school signs in with the **admin token** shown in the server environment (`ADMIN_TOKEN`). Use it once to open the console and add your Google account / passkey.

## 2. Create a registration token

Each school registers once — one public IP is one registration.

1. Open the **Cloud Admin Console** at `/admin`.
2. Under **Quick Actions**, choose **Create New Registration Token**.
3. Copy the one-time token and give it to the teacher who will register the school.

## 3. Register the school

On a machine inside the school's network:

1. Open the teacher app and choose **Register school**.
2. Enter the registration token.
3. The app calls `/api/v1/discover`, verifies the cloud-signed response and stores the school's public key.

You only do this once per school.

## 4. Grant screen-sharing access

When you start your first share, macOS asks for **Screen Recording** permission — this lets the class see the window you choose to share. Click **Allow** in System Settings → Privacy & Security → Screen Recording if you missed the prompt.

You control sharing at all times: nothing is broadcast unless you start a share.

## 5. Manage your team (optional)

In the admin console you can:

- **Add admins** — only allowlisted emails can sign in.
- **Register passkeys** — bound to your allowlisted admin account.
- **View the audit log** — every privileged action, who did what and when.

## 6. Update clients in bulk

Open **Settings → command panel** in the dashboard and send the signed `update` command. Every student client verifies your signature, downloads the new version over HTTPS and replaces itself — no `sudo`, no SSH to each machine.
