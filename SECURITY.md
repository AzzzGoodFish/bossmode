# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories:

https://github.com/AzzzGoodFish/bossmode/security/advisories/new

Do not open a public issue for credentials, authentication bypasses, private data exposure, or other exploitable findings. Include affected versions, reproduction steps, and impact when possible. We will acknowledge the report and coordinate disclosure after a fix is available.

## Credentials and local data

Bossmode stores user configuration and workspace data locally. Never commit `.env` files, credentials, runtime data, session data, logs, generated packages, or `.bossmode-attachments` to the repository.
