# Privacy Policy

**InHand — classroom wallpaper management and screen sharing software**

Effective date: **20 September 2026** · Version 1.2 · Prepared in accordance with the Personal Data (Privacy) Ordinance (Cap. 486) of the Laws of Hong Kong (the "PDPO")

## Contents

1. [Introduction](#1-introduction)
2. [Who we are and how this Policy applies](#2-who-we-are-and-how-this-policy-applies)
3. [Key concepts and roles](#3-key-concepts-and-roles)
4. [The personal data we collect](#4-the-personal-data-we-collect)
5. [How personal data is collected](#5-how-personal-data-is-collected)
6. [Purposes of collection and use](#6-purposes-of-collection-and-use)
7. [Use for new purposes and direct marketing](#7-use-for-new-purposes-and-direct-marketing)
8. [Disclosure and sharing](#8-disclosure-and-sharing)
9. [Cross-border transfers](#9-cross-border-transfers)
10. [Data security and local-first architecture](#10-data-security-and-local-first-architecture)
11. [Retention of personal data](#11-retention-of-personal-data)
12. [Children's privacy](#12-childrens-privacy)
13. [Screen sharing, monitoring and transparency](#13-screen-sharing-monitoring-and-transparency)
14. [Cookies and similar technologies](#14-cookies-and-similar-technologies)
15. [Automated decision-making and profiling](#15-automated-decision-making-and-profiling)
16. [Your rights under the PDPO](#16-your-rights-under-the-pdpo)
17. [Complaints to the Privacy Commissioner](#17-complaints-to-the-privacy-commissioner)
18. [Data breach response](#18-data-breach-response)
19. [Changes to this Policy](#19-changes-to-this-policy)
20. [Contact us](#20-contact-us)

---

## 1. Introduction

This Privacy Policy explains how the developer and operator of the InHand software (the "Developer", "InHand", "we", "us" or "our") collects, uses, discloses, retains and protects personal data in connection with the InHand classroom management software, comprising the InHand Student application, the InHand Admin control panel, and the associated cloud services (together, the "Service" or the "Software").

InHand is built on a **local-first, data-minimisation architecture**: classroom management and screen sharing operate strictly across the School's local area network (LAN). If classroom data does not need to leave the School's network, it does not leave it.

We are committed to protecting the privacy of all individuals who use the Service in accordance with the Personal Data (Privacy) Ordinance (Cap. 486) of the Laws of Hong Kong (the "PDPO") and the six Data Protection Principles ("DPPs") set out in Schedule 1 to the PDPO. This Policy describes:

- what personal data is processed on School-owned devices and why;
- how personal data is handled on the LAN versus the cloud;
- our security and cryptographic safeguards;
- how long personal data is retained; and
- your rights under Hong Kong law, including access, correction, and deletion.

By installing, accessing or using the Service, or by deploying the Service on School property, you acknowledge that you have read and understood this Policy. If you are a student, please review this Policy together with your School, as the software operates on School-owned hardware assigned to you for educational purposes.

## 2. Who we are and how this Policy applies

The Service is developed and operated by the InHand development team (the "Developer"). The Service enables schools, colleges, universities and educational institutions (each a "School") to manage desktop wallpapers on School-owned student devices, share screens within a classroom network, and apply network controls on those devices within the School's local area network ("LAN").

This Policy applies to:

- **Students** using School-owned macOS devices (School assets) running the InHand Student application;
- **Teachers and administrators** who use the InHand Admin control panel; and
- **School IT administrators** who register a School with the cloud service and manage registration tokens.

Where the Service is deployed, the devices running the software are **institutional assets owned and administered by the School**. Under the PDPO, the School acts as the **data user** in respect of student personal data processed on its devices, and we act as the School's **data processor** (or agent). We act as a data user solely in respect of teacher/administrator account credentials and cloud service operational metadata.

## 3. Key concepts and roles

> **Personal data** has the meaning given in section 2(1) of the PDPO: data relating directly or indirectly to a living individual, from which it is practicable for the identity of the individual to be directly or indirectly ascertained, and in a form in which access to or processing of the data is practicable.
>
> **Data user** means a person who, either alone or jointly or in common with other persons, controls the collection, holding, processing or use of personal data (PDPO, section 2(1)).
>
> **Data processor** means a person engaged by or acting on behalf of a data user to process personal data on the data user's instructions (PCPD guidelines and section 65 of the PDPO).

| Role | Who | Relationship to personal data |
|---|---|---|
| Data user (students' data) | The School | Controls the hardware assets, the network environment, and the purposes for collecting and using student data through the Service. |
| Data processor | The Developer (InHand) | Processes student data strictly on the School's instructions through software logic; acts as data user solely for cloud service maintenance and administrator identity records. |
| Data subjects | Students, teachers, administrators | The individuals to whom the data relates. |

## 4. The personal data we collect

In accordance with DPP1(1), we collect only data that is strictly necessary for classroom management. No wallpapers, browsing history, personal files, or documents are ever uploaded to our cloud infrastructure.

### 4.1 Data collected from the InHand Student application (School-owned devices)

The student application runs in user space under `~/Library/Application Support/InHand/` on the School's macOS asset without requiring a root daemon. It processes:

| Category | Examples | Why collected / Handled |
|---|---|---|
| Device identifier and display name | macOS account username of the assigned user (e.g. `alexwong`), unique device UUID | To identify the School device in the teacher's admin panel and route commands to the correct station. |
| Network information | LAN IP address, port presence, socket connection state | To enable discovery of the teacher's server over the LAN and maintain communication. |
| Screen content (only during active sharing or viewing) | Real-time screen capture transmitted point-to-point over the School's LAN | To facilitate classroom screen sharing. Transmitted directly over LAN; **never** sent to the cloud. |
| Session metadata & command results | Whitelisted command execution outcomes (e.g. wallpaper applied), session duration | Displayed on the teacher's admin console and recorded in local audit logs. |
| Support & diagnostic data (optional) | Crash logs, execution traces | Collected **only if voluntarily submitted** by the School's IT staff for troubleshooting. |

**System Permissions on School Assets:** The student application utilizes standard macOS **Screen Recording** permissions. This allows the teacher to view the screen during an active lesson. On School-managed devices, this permission is typically configured by the School's IT administrator (via Mobile Device Management / MDM profiles) or granted during initial device provisioning.

### 4.2 Data collected from the InHand Admin control panel (teachers and administrators)

| Category | Examples | Why collected |
|---|---|---|
| School registration details | School name, public key, registration token reference | To register the School endpoint with the cloud discovery service. |
| Cryptographic credentials | Encrypted teacher keypair (Ed25519 signing key, X25519 encryption key), local passphrase-protected keyring | To sign management commands and decrypt student reports. Private keys **never** leave the local device. |
| Classroom device history & audit logs | Connected School device names, first-seen and last-seen timestamps, command records | Maintained locally on the teacher's Mac for classroom continuity, accountability, and security auditing. |
| Network information | LAN IP address and local listening port | Published via the signed cloud discovery service so School devices on the same LAN can connect. |

### 4.3 Data collected by the cloud service

The cloud service is limited to discovery, authentication, and update verification:

| Category | Examples | Why collected |
|---|---|---|
| Registration records | School name, public signing and encryption keys, LAN IP/port of the teacher's console, registration token | To authenticate teacher instances and allow student devices to securely discover the local teacher server without manual IP configuration. |
| Cloud console credentials | Administrator email address, WebAuthn passkey credentials, or federated identity identifiers | To restrict access to the School's cloud configuration console. |
| Update manifests | Software version, platform, download URL, SHA-256 file hashes | To serve verifiable, tamper-proof software updates to client applications. |
| Cloud access logs | Timestamps, public IP addresses of API callers, HTTP request metadata | For security, abuse prevention, and rate-limiting. |

We do not collect sensitive personal data (such as biometric data, health information, or religious beliefs) through the Service.

## 5. How personal data is collected

- **From the School:** when IT administrators configure School-owned devices, register the School token, or assign device naming conventions.
- **Automatically across the School LAN:** when the student application connects to the teacher's local admin server over the campus network.
- **Voluntarily for support:** crash logs and diagnostic traces are collected only when explicitly exported and sent to us by the School.

In accordance with DPP1(2), personal data is collected by lawful and fair means, and is not excessive for classroom management on institutional hardware.

## 6. Purposes of collection and use

Personal data is collected and used strictly for purposes directly related to the Service (DPP1 and DPP3):

1. **Local classroom management:** applying wallpapers, managing screen sharing, and enforcing focus modes across School-owned devices on the LAN.
2. **Cryptographic discovery and connection:** allowing student devices to discover the verified teacher server via signed cloud discovery responses.
3. **Security, authenticity and audit:** ensuring commands originate from an authorised teacher (via Ed25519 signatures) and maintaining tamper-evident local audit trails.
4. **Verified software updates:** distributing signed update manifests checked against SHA-256 hashes.
5. **Support and issue resolution:** diagnosing bugs using audit logs or crash reports provided by the School.
6. **Legal and regulatory compliance:** complying with applicable Hong Kong laws or lawful regulatory requests.

We do not use personal data for any purpose other than those stated above without prescribed consent.

## 7. Use for new purposes and direct marketing

### 7.1 New purposes

In accordance with DPP3, we will not use personal data for a new purpose unless we have obtained the express, voluntary, written consent ("prescribed consent") of the deploying School (as authorised data user), or where an exemption under Part 8 of the PDPO applies.

### 7.2 Direct marketing

We do not sell, rent, or use personal data collected through the Service for direct marketing. If we ever intend to introduce direct marketing, we will strictly comply with Part 6A of the PDPO (sections 35A to 35F), providing prior written notification, obtaining explicit opt-in consent, and offering an unconditional, free opt-out mechanism.

## 8. Disclosure and sharing

We do not sell or commercialise personal data. Data is shared only under strict operational boundaries:

### 8.1 Strictly within the School LAN

Screen streams, applied wallpapers, and local audit logs circulate **strictly within the School's local network**. Screen sharing operates point-to-point between School-owned devices and is never routed through our cloud servers.

### 8.2 Service providers (Data processors)

We engage selected third-party infrastructure providers to host cloud components under strict confidentiality and security terms comparable to the PDPO:

| Provider | Purpose | Data Handled |
|---|---|---|
| Cloud hosting provider (e.g. Vercel, Inc.) | Hosting the cloud discovery and update manifest API | Registration records, public keys, LAN IP pointers, request logs |
| Identity provider (e.g. Google LLC / Firebase) | Administrator console sign-in | Administrator email, session authentication tokens |
| Distribution infrastructure (e.g. GitHub Releases) | Binary package downloads | Anonymous package download requests (subject to standard web access logs) |

### 8.3 Legal disclosures

We may disclose personal data if required to do so by a Hong Kong court order, statute, or lawful request from law enforcement or the PCPD, in compliance with the PDPO.

## 9. Cross-border transfers

Cloud registration records and administrator authentication data may be hosted on infrastructure located outside Hong Kong (such as the United States or Singapore).

While section 33 of the PDPO is not yet in operation, we adhere to the guidance of the Privacy Commissioner for Personal Data (PCPD):
- Data transfers outside Hong Kong are limited to the minimum necessary to provide the cloud discovery and update services;
- Service providers are subject to rigorous data protection terms and industry-standard security certifications; and
- Screen media and classroom contents **never cross borders**, as they remain strictly on the School's internal network.

## 10. Data security and local-first architecture

In accordance with DPP4, we apply layered technical and organisational safeguards:

### 10.1 Cryptographic protections
- **End-to-end device communication:** Student applications and the teacher's admin console communicate using public-key cryptography (ECIES encryption based on X25519 key agreement, HKDF, and AES-256-GCM). A student client only accepts commands verified by the teacher's Ed25519 signature.
- **Signed cloud discovery:** The cloud signs every discovery response. Client devices verify this cryptographic signature before trusting the teacher's LAN address and public keys, preventing spoofing and man-in-the-middle attacks on the local network.
- **Encrypted screen transmission:** WebRTC media streams are encrypted in transit using DTLS-SRTP over the local network. Signalling is protected via ECIES.
- **Key protection at rest:** Teacher private keys are stored in a local keyring encrypted with AES-256-GCM using keys derived via scrypt. Private keys never leave the teacher's Mac.

### 10.2 Tamper-proof updates
Every application update is verified before execution:
1. The client downloads update files over HTTPS.
2. The client checks the package against the published **SHA-256** hash and verifies the **macOS code signature**.
3. Only upon successful verification does the application atomically replace its binary, preventing execution of modified or corrupted code.

### 10.3 Principle of least privilege on student devices
- The InHand Student application installs in user space (`~/Library/Application Support/InHand/`).
- It runs with standard user privileges—it requires **no root daemon**, no system extension, and no world-writable directories.
- System permissions on School assets are managed under institutional policies established by the School's IT administration.

## 11. Retention of personal data

In compliance with DPP2, personal data is kept only as long as necessary:

| Data | Storage Location | Retention Period |
|---|---|---|
| Classroom audit logs | Local School Mac (Teacher / Student) | Retained until cleared by the School IT staff or upon software uninstallation / device re-imaging. |
| Teacher keys and keyring | Local School Mac (Teacher) | Retained until deleted by the teacher or upon uninstallation. |
| Cloud discovery registration | Cloud infrastructure | Active only during the session/registration lifetime; automatically invalidated upon expiry or token revocation. |
| Administrator account data | Cloud infrastructure | Retained until deleted by the School administrator. |
| Diagnostic / Crash logs | Developer support systems | Retained for up to 90 days after issue resolution, then permanently deleted. |

## 12. Children's privacy

InHand is deployed on School-owned devices used in educational environments:
- The School, acting as the asset owner and data user, is responsible for establishing lawful grounds (including institutional policies and parental/guardian notification) for deploying software on School-assigned devices.
- InHand collects no behavioral profiling data, serves no advertisements, and creates no student cloud profiles.
- Screen sharing is strictly local, visible, and governed by classroom transparency measures.

## 13. Screen sharing, monitoring and transparency

Screen viewing is designed for instructional supervision on School property, subject to clear safeguards:
- **Teacher-initiated:** Viewing is initiated explicitly by the teacher selecting a specific display or window.
- **Visible sharing state:** When screen viewing or focus mode is active, the student application indicates on-screen that screen sharing is in progress.
- **Clean exit:** The teacher may end screen sharing or exit focus mode at any time, returning student devices to their normal operating state automatically.
- **Strictly LAN-bound:** Screen captures travel solely across the School's LAN and are neither recorded by InHand nor streamed to the cloud.

## 14. Cookies and similar technologies

The cloud administration console uses strictly necessary session cookies (HttpOnly, SameSite, secure) to manage administrator sign-in. We do not use third-party tracking, advertising, or analytics cookies.

## 15. Automated decision-making and profiling

The Service does not perform automated decision-making, scoring, or behavioral profiling. Commands (such as setting wallpapers or applying local focus rules) are executed directly based on explicit teacher instructions on institutional devices.

## 16. Your rights under the PDPO

Under sections 18, 22, and 23 of the PDPO, data subjects have the right to:
- **Ascertain** whether personal data is held;
- **Request access** to personal data within statutory time limits (ordinarily 40 days);
- **Request correction** of inaccurate personal data; and
- **Withdraw consent** where processing relies upon consent.

Because the School is the owner of the devices and the data user under the law, students and parents should direct access and correction requests regarding school device records to the **School** in the first instance. We will support the School in fulfilling statutory requests.

## 17. Complaints to the Privacy Commissioner

If you believe your personal data privacy has been infringed, you may lodge a complaint with the Office of the Privacy Commissioner for Personal Data, Hong Kong:

> **Office of the Privacy Commissioner for Personal Data (PCPD)**
> 12/F, 248 Queen's Road East, Wan Chai, Hong Kong
> Telephone: +852 2827 2827 · Website: [www.pcpd.org.hk](https://www.pcpd.org.hk)

We encourage you to contact the School or our Privacy Officer first so we can promptly address your concerns.

## 18. Data breach response

In the event of a suspected personal data breach, we follow established containment and mitigation procedures:
- Prompt technical investigation and risk containment;
- Immediate notification to affected Schools (as data users); and
- Voluntary notification to the PCPD and affected data subjects in line with PCPD guidance where there is a risk of meaningful harm.

## 19. Changes to this Policy

We may update this Policy to reflect technical updates or legal changes. Updates will be posted on our website with a revised effective date. Material changes will be communicated via the application or to School administrators prior to taking effect.

## 20. Contact us

For privacy questions, access requests, or regulatory inquiries:

> **InHand Privacy Officer**
> Email: privacy@inhand.example *(or developer contact email)*
> Address: Hong Kong Special Administrative Region

---

*Governed by the laws of the Hong Kong Special Administrative Region.*