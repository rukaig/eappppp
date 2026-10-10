# EAPIHS Assistant

EAPIHS Assistant is a responsive school-support web app for students and the wider
EAPIHS school community. The school seal in `assets/aldous.jpg` is used on the loading
screen; resized PNG versions in `assets/` provide the install icons.

## Netlify prototype

This repository is ready for a static Netlify deploy. Netlify runs `npm run build`,
which copies the browser app and its assets into `dist/`, including `index.html`
as the root entry page (copied from `appli.html`). For a quick prototype test without connecting GitHub, install
Node.js 18 or newer, run `npm.cmd run build` from PowerShell (`npm run build` in
other shells), then drag the generated `dist/` folder into Netlify's manual
deploy page.

For repeatable deploys, push this project to a GitHub repository, choose
**Add new site → Import an existing project** in Netlify, and connect the
repository. Netlify reads the build command (`npm run build`) and publish
directory (`dist`) from `netlify.toml`. Open the resulting HTTPS URL to test on
desktop and mobile.

The hosted prototype keeps account records and the remembered sign-in in that
browser's local storage. Passwords are stored as salted PBKDF2 verifiers, not
plain text. This is only a local demo gate: accounts do not sync between devices,
and browser storage is not a secure production identity system. Do not use a
real/reused password or sensitive student information. Production sign-in needs
a trusted identity provider and server-side database, with appropriate school
privacy and consent safeguards.

Netlify's static deploy does not run `server.js`. AI answers, voice recognition,
study-room chat, and calls that require `/api/*` or `/realtime` need the separate
Node backend described below. Do not put provider credentials in the static site.

## Install on Apple, Android, and Windows

The app is a responsive website with a web app manifest and the EAPIHS seal as
its icon. Use the deployed HTTPS URL:

- **iPhone/iPad:** open the URL in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open it in Chrome and choose **Install app** or **Add to Home screen**
  from the browser menu.
- **Windows:** open it in Microsoft Edge, open **Settings and more (…) → Apps**,
  then choose **Install this site as an app**.

Menu wording varies by OS/browser. The install remains a web app (PWA), not a
separately packaged App Store, Google Play, or Microsoft Store application.
The QR code in the app or at `/qr.html` opens the deployed `/appli.html` page;
it does not download an HTML file. Scanning requires the site to be deployed at
an HTTPS URL.

## Run the complete Node backend

1. Install Node.js 18 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `MODEL_API_KEY` if AI answers are needed.
4. Run `npm start`.
5. Publish with a Node host that supports WebSocket upgrades at `/realtime`
   (for example Render, Railway, or Fly.io), then open the hosted app URL.

The Node server serves the static pages, provides `GET /api/health` and
`POST /api/assistant`, and handles realtime study-room chat and WebRTC signaling.
The voice endpoint also requires Tencent ASR credentials. Keep all provider keys
in the server's environment, never in the browser bundle. The direct HTML
download endpoint `GET /download/appli.html` is not used for PWA installation.

The assistant uses Groq's OpenAI-compatible Chat Completions endpoint by default.
Set `MODEL_API_BASE_URL` and `MODEL_API_MODEL` to use another compatible provider.
Its school-focused behavior is defined in `server.js`; this is prompt
configuration, not model training.
