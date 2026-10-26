# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ShotShare: a static site (HTML, CSS, jQuery only — no build step, no backend, no package.json, no tests or linter) that lets anyone sign in with Dropbox, paste/drop screenshots, upload them to the user's Dropbox **app folder**, and get public share links. Every Dropbox call goes straight from the browser to the Dropbox API v2.

## Run

```sh
python3 -m http.server 8080   # open http://localhost:8080/
```

PKCE needs a secure context, so `file://` does not work. The served address must be registered exactly (no trailing slash at the domain root) under **Redirect URIs** in the Dropbox App Console, otherwise Dropbox shows "Invalid redirect_uri". Each different origin/port needs its own entry.

## Architecture

Scripts load in order from `index.html`: jQuery 3.7.1 → jQuery UI 1.13.3 (datepicker only; pinned with SRI hashes) → `js/config.js` → `js/dropbox.js` → `js/app.js`.

- **`js/config.js`** — `window.SHOTSHARE_CONFIG` (`appKey`, `redirectUri`, `maxConcurrentUploads`). Only the app key (client id) is needed; never add an app secret. When `redirectUri` is blank it's derived from the page address (origin alone at the root, origin+folder in a subfolder). When it's set, `app.js` redirects the browser to that origin at startup, because sign-in state is per origin.
- **`js/dropbox.js`** → `window.DropboxClient`: the only module that talks to Dropbox.
  - OAuth 2.0 Authorization Code + PKCE (S256, `token_access_type=offline`). The verifier and state live in `sessionStorage` (`shotshare.pkce`); tokens, including the refresh token, live in `localStorage` (`shotshare.auth`).
  - The explicit `SCOPES` list is personal-account scopes only. Adding team scopes makes Dropbox demand a work account.
  - All requests go through `send()`. A 401 refreshes the token once and then expires the session, firing `$(document).trigger('dropbox:signedout')`. A 429/503 retries using Retry-After. Errors are converted to user-friendly messages in `toError`.
  - Content endpoints pass args in the `Dropbox-API-Arg` header, which must be ASCII-escaped (`headerSafeJson`).
  - Every public function returns a promise.
- **`js/app.js`** — all UI, in one IIFE with a `state` object.
  - **Views**: the views are `#view-login` (the SEO landing page), `#view-upload` and `#view-gallery`, switched by `showView()`. Signed in, routing uses `#upload` / `#gallery` hashes. Signed out, landing-section links smooth-scroll and the hash is stripped from the URL on purpose.
  - **Uploads**: a queue capped at `MAX_CONCURRENT`, where each task runs upload → create shared link.
  - **Gallery**: built from `list_folder` plus `list_shared_links`, with lazy thumbnail batches (25 at a time via IntersectionObserver), date and time-of-day filters, and bulk delete.
  - **Dialogs**: confirmations use the native `<dialog>` (`confirmDialog`). Repeated markup is cloned from `<template>`s in `index.html`.
- **`index.html`** — the landing content (hero, how it works, features, shortcuts, FAQ) is static HTML so crawlers can read it without JS.
  - The JSON-LD `FAQPage` in `<head>` must stay in sync with the visible FAQ.
  - An inline head script adds `has-session` to `<html>` for returning users to avoid a landing flash. `.guest-only` / `.auth-only` elements are toggled by that class and by `showView`.
  - Every sign-in button is `.btn-dropbox.js-login` with a `.btn-label` span. The click handler changes only the label text, so the Dropbox glyph stays.
- **`css/style.css`** — design tokens on `:root` with a `prefers-color-scheme: dark` override. Layout breakpoints are 900/860/480px.

## Deployment notes

- `https://shotshare.example.com` is a placeholder in `index.html` (canonical, OG/Twitter tags, JSON-LD), `robots.txt` and `sitemap.xml`. Replace it with the real domain before going live; the README has a sed one-liner for this.
- Production must be HTTPS and its URL registered as a redirect URI.
- A Dropbox app in development mode allows only a limited number of users until "Enable additional users" is clicked or production status is approved in the App Console.
- `img/og-image.png` and `img/apple-touch-icon.png` are rendered images of the logo. Regenerate them if the logo SVG in `index.html` (the `.brand-mark` element and the favicon data URI) changes.
