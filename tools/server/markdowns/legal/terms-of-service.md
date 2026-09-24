
# Terms of Service

**InHand — classroom wallpaper management and screen sharing software**

Effective date: **20 September 2026** · Version 1.2 · Governed by the laws of the Hong Kong Special Administrative Region

## Contents

1. [Introduction and acceptance](#1-introduction-and-acceptance)
2. [Definitions](#2-definitions)
3. [About the Service and operational architecture](#3-about-the-service-and-operational-architecture)
4. [Eligibility and deployment by Schools](#4-eligibility-and-deployment-by-schools)
5. [Accounts, registration tokens and security](#5-accounts-registration-tokens-and-security)
6. [Licence grant and system permissions](#6-licence-grant-and-system-permissions)
7. [Acceptable use](#7-acceptable-use)
8. [Screen sharing and monitoring — acceptable use](#8-screen-sharing-and-monitoring--acceptable-use)
9. [Obligations of Schools and Users](#9-obligations-of-schools-and-users)
10. [Third-party services](#10-third-party-services)
11. [Availability and support](#11-availability-and-support)
12. [Fees](#12-fees)
13. [Intellectual property](#13-intellectual-property)
14. [Privacy](#14-privacy)
15. [Disclaimers](#15-disclaimers)
16. [Limitation of liability](#16-limitation-of-liability)
17. [Indemnity (institutional)](#17-indemnity-institutional)
18. [Termination](#18-termination)
19. [Changes to these Terms](#19-changes-to-these-terms)
20. [Governing law and jurisdiction](#20-governing-law-and-jurisdiction)
21. [General provisions](#21-general-provisions)
22. [Contact us](#22-contact-us)

---

## 1. Introduction and acceptance

These Terms of Service (the "Terms") govern access to and use of the InHand classroom management software (the "Service" or "Software"), comprising the InHand Student application, the InHand Admin control panel, and associated cloud services.

By installing, accessing or using the Service, or by deploying it on School assets within an educational institution, you agree to these Terms. If you are entering into these Terms on behalf of a school, college, university, or educational organisation (a "School"), you represent and warrant that you have full legal authority to bind that School.

These Terms must be read in conjunction with our [Privacy Policy](privacy-policy.md), which forms part of this agreement.

## 2. Definitions

> **"Admin Panel"** means the InHand Admin software used by teachers and School IT personnel to manage wallpapers, view screens, and issue management commands over the LAN.
>
> **"Cloud Service"** means the cloud discovery and update manifest services operated by the Developer.
>
> **"Developer", "we", "us", "our"** means the developers and operators of the InHand software.
>
> **"School"** means the educational institution licensing, deploying, and owning the hardware assets on which the Service is installed.
>
> **"Student"** means an individual student using a School-owned macOS device running the InHand Student application.
>
> **"Teacher"** means an authorised educator or staff member operating the Admin Panel.
>
> **"User"** means any individual accessing or operating the Software on School assets.

## 3. About the Service and operational architecture

InHand provides local-first classroom management:
- **LAN-based operations:** Wallpaper settings, screen sharing, and focus controls operate over the School's local area network (LAN). Classroom content and screen media do not travel to the cloud.
- **Signed cloud discovery:** The Cloud Service acts as a lightweight cryptographic directory enabling student devices to discover the verified teacher server on the local network without manual IP configuration.
- **Per-user footprint:** The student application runs in user space (`~/Library/Application Support/InHand/`) without requiring root system daemon privileges.

The Developer provides software tools; the School remains solely responsible as the asset owner for hardware supervision, classroom administration, and institutional compliance with applicable laws.

## 4. Eligibility and deployment by Schools

### 4.1 Institutional agreement and minors
The contractual agreement established under these Terms is between the **School** (as an institution and property owner) and the Developer. Students use the application on School-owned assets as authorised end-user beneficiaries under the School's institutional administration. Students are not contracting parties to the commercial covenants of these Terms.

### 4.2 School asset ownership and administration
Where a School deploys the Service, the School represents and warrants that:
- The macOS hardware running the Software constitutes **School assets owned, leased, or managed by the School**;
- The School holds full authority to install, configure, and operate administrative tools (including wallpaper and screen management) on its own devices;
- The School maintains institutional policies governing the acceptable use of School-owned hardware by students; and
- The School maintains proper administrative control over registration tokens and access credentials.

## 5. Accounts, registration tokens and security

### 5.1 Registration tokens
Schools connect to the cloud discovery service using registration tokens. Registration tokens are confidential credentials:
- Tokens must be kept secure and shared only with authorised IT administrators and Teachers;
- Schools are responsible for all registrations executed using their assigned tokens; and
- Compromised tokens must be revoked promptly via the cloud administration console.

### 5.2 Cryptographic keypairs
The Admin Panel generates an Ed25519/X25519 keypair protected by a local passphrase. Private keys are stored exclusively on the teacher's Mac and cannot be recovered by the Developer if the passphrase is lost.

### 5.3 System security covenants
Users and Schools agree not to:
- Attempt to forge, replay, or bypass cryptographic signatures or nonce checks;
- Tamper with or reverse-engineer signed discovery responses; or
- Exploit any software vulnerability discovered in the Service (all vulnerabilities should be reported responsibly to the Developer).

## 6. Licence grant and system permissions

### 6.1 Licence grant
Subject to these Terms, we grant the School a non-exclusive, non-transferable, revocable licence to install and run the Software in object-code form on School-owned devices solely for internal educational purposes within the School's local network.

### 6.2 System permissions on School hardware
The InHand Student client installs into the standard user application support directory (`~/Library/Application Support/InHand/`). To facilitate classroom screen viewing, the application requests the standard macOS **Screen Recording** permission. On School-managed devices, this permission is administered by the School's IT department (via Mobile Device Management / MDM configuration profiles) or granted during asset setup.

### 6.3 Licence restrictions
Except as permitted by mandatory provisions of the Copyright Ordinance (Cap. 528) of Hong Kong, you shall not:
- Decompile, disassemble, or reverse engineer the binary components of the Service;
- Sublicence, rent, lease, or commercialise the Software to third parties; or
- Remove or alter any copyright notices or cryptographic verification routines.

## 7. Acceptable use

You agree not to use the Service:
- In violation of any applicable laws of Hong Kong or the jurisdiction in which the School operates;
- To transmit or display defamatory, obscene, harassing, or unlawful material across School devices;
- To circumvent campus security controls or intercept communications outside authorised classroom management; or
- To interfere with the stability of the Cloud Service or campus network.

## 8. Screen sharing and monitoring — acceptable use

Screen viewing and sharing functions on School assets must be exercised responsibly:
- **Educational purpose:** Screen sharing and viewing must be used strictly for instruction, academic assistance, or classroom supervision;
- **Classroom focus:** Teachers shall not view student screens outside instructional periods or outside the School's LAN;
- **Transparency:** The student application provides on-screen visibility when screen viewing or focus mode is active. Teachers can terminate sharing at any time, returning student devices to their normal state automatically; and
- **No cloud recording:** Screen media is transmitted locally and ephemeral; the Service does not record or store screen streams in the cloud.

## 9. Obligations of Schools and Users

Schools and Users agree to:
- Provide accurate School details upon registration;
- Maintain system updates and supported macOS versions on School-owned hardware; and
- Promptly report any security breach or unauthorized access involving registration tokens.

## 10. Third-party services

The Cloud Service and installer distribution rely on third-party cloud infrastructure (e.g. Vercel, Firebase, GitHub Releases). We do not warrant the uninterrupted availability of third-party networks, though core classroom functions are designed to continue operating over the LAN even during external internet interruptions.

## 11. Availability and support

The Service is provided on a best-efforts basis. The Cloud Service may experience temporary maintenance outages. LAN-based classroom management operates independently of cloud connectivity once local discovery is established. Technical support is offered at the Developer's discretion unless otherwise agreed under a separate written service level agreement.

## 12. Fees

The Service is currently offered free of charge. The Developer reserves the right to introduce premium tiers or paid enterprise features in the future upon reasonable advance notice.

## 13. Intellectual property

The Developer and its licensors retain all Intellectual Property Rights in the Service, including software binaries, code signatures, documentation, and trademarks. Schools retain ownership of all instructional content, images, and wallpapers displayed through the Service.

## 14. Privacy

Handling of personal data is governed by our [Privacy Policy](privacy-policy.md). The School acts as the **Data User** under the PDPO for student personal data, while the Developer acts as a **Data Processor**.

## 15. Disclaimers

To the maximum extent permitted under Hong Kong law (including the Control of Exemption Clauses Ordinance, Cap. 458):
- The Service is provided **"as is"** and **"as available"** without warranties of merchantability, fitness for a particular purpose, or error-free operation;
- InHand is an instructional classroom management utility, not an enterprise network firewall, proctoring security suite, or physical life-safety system; and
- We do not warrant that the Software will prevent all unapproved student device activity.

## 16. Limitation of liability

### 16.1 Exclusion of indirect damages
To the maximum extent permitted by applicable law, neither party shall be liable for indirect, incidental, consequential, special, or punitive damages, nor for loss of profits, data, or operational downtime, arising under or in connection with the Service.

### 16.2 Liability cap
To the maximum extent permitted by law, the aggregate liability of the Developer arising out of or related to these Terms or the Software shall not exceed the greater of:
1. The total amounts paid by the School to the Developer for the Service in the twelve (12) months preceding the claim; or
2. **HK$1,000**.

### 16.3 Non-excludable statutory liability
Nothing in these Terms limits or excludes liability for death or personal injury caused by negligence, fraud, or any other liability which cannot be lawfully excluded under Hong Kong law.

## 17. Indemnity (institutional)

The **School** agrees to indemnify, defend, and hold harmless the Developer and its team members from and against any third-party claims, liabilities, damages, or reasonable legal costs arising out of:
- The School's deployment, operation, or configuration of the Software on its hardware assets;
- The School's failure to provide requisite institutional notices or comply with the PDPO; or
- Material breach of these Terms by the School's administrative personnel.

**Exclusion:** Individual Students (and their parents/guardians) are specifically **excluded** from this indemnity covenant.

## 18. Termination

- **By the School:** The School may terminate at any time by uninstalling the Software from its devices and revoking its cloud registration token.
- **By the Developer:** We may suspend or revoke cloud access upon written notice if the School materially breaches these Terms, misuses the Cloud Service, or compromises system security.
- **Survival:** Sections 13, 15, 16, 17, 20, and 21 survive termination.

## 19. Changes to these Terms

We may update these Terms to reflect technical enhancements or statutory changes. Revised Terms will be published with an updated Effective Date. Continued use of the Service following published updates constitutes acceptance.

## 20. Governing law and jurisdiction

These Terms are governed by and construed in accordance with the **laws of the Hong Kong Special Administrative Region**.

The courts of Hong Kong shall have exclusive jurisdiction over any dispute or claim arising out of or in connection with these Terms or the Service.

## 21. General provisions

- **Entire agreement:** These Terms and the Privacy Policy constitute the entire agreement between the parties regarding the Service.
- **Severability:** If any provision is held invalid or unenforceable, it shall be enforced to the maximum extent permissible, and the remaining provisions shall remain in full effect.
- **No waiver:** Failure to enforce any right under these Terms does not constitute a waiver of future enforcement.

## 22. Contact us

For contractual inquiries or institutional notices:

> **InHand Legal Notices**
> Email: legal@inhand.example *(or developer contact email)*
> Address: Hong Kong Special Administrative Region

---

*Governed by the laws of the Hong Kong Special Administrative Region.*