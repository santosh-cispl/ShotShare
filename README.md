# ShotShare

Paste a screenshot, get a shareable Dropbox link. A static site (HTML, CSS, jQuery) with no backend: sign-in, uploads, links and deletes all go straight from the browser to the Dropbox API.

## Features

- **Dropbox sign-in** with OAuth 2.0 + PKCE: no app secret. Tokens (including a refresh token) live in `localStorage`, so you stay signed in until you log out. Logging out revokes the token.
- **Paste to upload** (⌘ V / Ctrl V) anywhere on the page, plus drag & drop and a multi-file picker. Uploads run in parallel, each with its own progress bar.
- **Share links**: every upload gets a public Dropbox shared link with a one-click **Copy link** button.
- **Your images**: a thumbnail gallery showing file name, upload date/time and share link. Click a thumbnail to preview the image.
- **Filters**: a date range plus time of day (morning / afternoon / evening / night presets, or a custom range that can wrap past midnight).
- **Bulk delete**: tick checkboxes (or "Select all" visible), confirm, and the files are deleted from Dropbox in one batch.
- **Storage meter** in the header (used vs. available), plus readable error messages for expired sessions, missing permissions, a full Dropbox, rate limits and network problems.

## Setup

1. Create an app at <https://www.dropbox.com/developers/apps>:
   - **Scoped access** → **App folder** → give it a name (e.g. `ShotShare`). Files end up in `Dropbox/Apps/<name>/`.
2. **Permissions** tab: enable these scopes, then click **Submit**:
   - `account_info.read`
   - `files.metadata.read`
   - `files.content.write`
   - `files.content.read`
   - `sharing.write`
   - `sharing.read`
3. **Settings** tab:
   - Under **OAuth 2 → Redirect URIs**, add the URL the app is served from, exactly as the sign-in page shows it under **Redirect URI**: e.g. `http://localhost:8080` (local) or `https://shots.example.com`. A site at the domain root uses no trailing slash; a subfolder keeps it (`https://example.com/shotshare/`).
   - Make sure **Allow public clients (Implicit Grant & PKCE)** is set to **Allow**.
   - Copy the **App key**. You do not need the app secret.
4. Put the app key in `js/config.js`:

   ```js
   window.SHOTSHARE_CONFIG = {
     appKey: 'abc123yourkey',
     redirectUri: '',          // blank = built from the page's address; set only to force one fixed URL
     maxConcurrentUploads: 2
   };
   ```

   `/` and `/index.html` produce the same redirect URI, so one entry covers both. Each different address (another port, `127.0.0.1`, your live domain) needs its own entry in the App Console.

## Going live (SEO)

The signed-out home page is a full landing page (how it works, features, shortcuts, FAQ) written straight into `index.html`, so search engines can read it without running JavaScript. It also includes a title and description, Open Graph/Twitter preview tags, `WebApplication` + `FAQPage` structured data, `robots.txt` and `sitemap.xml`.

Before deploying, replace the placeholder domain `https://shotshare.example.com` with your real one:

```sh
grep -rl "shotshare.example.com" index.html robots.txt sitemap.xml | xargs sed -i '' 's#https://shotshare.example.com#https://your-domain.com#g'
```

Then add the site in [Google Search Console](https://search.google.com/search-console), verify it, and submit `https://your-domain.com/sitemap.xml`. Serve the live site over HTTPS (Dropbox sign-in requires it, and Google prefers it). Indexing usually takes a few days to a few weeks.

## Run locally

PKCE needs a secure context, so serve the app over `http://localhost` or `https://`; opening `index.html` as a `file://` URL won't work:

```sh
python3 -m http.server 8080
# open http://localhost:8080/
```

Any static host works for deployment (Netlify, GitHub Pages, S3, nginx…), as long as it uses HTTPS and its URL is registered as a redirect URI.

## Files

```
index.html       markup, dialogs and <template>s for upload rows and gallery cards
css/style.css    styles (light + dark mode, responsive)
js/config.js     app key / redirect URI
js/dropbox.js    PKCE sign-in, token refresh, jQuery AJAX wrappers for the Dropbox API
js/app.js        UI: paste/drop/pick uploads, gallery, filters, selection, delete, storage
```

## Notes

- Upload times come from Dropbox's `server_modified` and are shown and filtered in your local time zone.
- Single uploads are capped at 150 MB (the Dropbox `files/upload` limit). Non-image files are skipped with a message.
- Thumbnails load lazily in batches of 25 as you scroll. Formats Dropbox can't thumbnail (SVG, HEIC, files over 20 MB) show a placeholder.
- Keeping the token in `localStorage` is what lets you stay signed in. The trade-off is that any script running on the page could read it, so don't add untrusted third-party scripts to this site.
