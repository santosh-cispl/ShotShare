/*
 * ShotShare – Dropbox client.
 *
 * OAuth 2.0 Authorization Code flow with PKCE (runs entirely in the browser, no
 * app secret) plus thin jQuery AJAX wrappers around the Dropbox HTTP API v2.
 * Tokens are kept in localStorage so the user stays signed in until logout.
 */
(function (window, $) {
  'use strict';

  var cfg = window.SHOTSHARE_CONFIG || {};
  var AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
  var TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  var RPC_URL = 'https://api.dropboxapi.com/2/';
  var CONTENT_URL = 'https://content.dropboxapi.com/2/';
  var AUTH_KEY = 'shotshare.auth';
  var PKCE_KEY = 'shotshare.pkce';
  var MAX_RETRIES = 3;
  var DELETE_BATCH_LIMIT = 1000;
  // Personal-account scopes only; requesting team scopes forces a work-account sign-in.
  var SCOPES = [
    'account_info.read',
    'files.metadata.read',
    'files.content.read',
    'files.content.write',
    'sharing.read',
    'sharing.write'
  ];

  var auth = readAuth();
  var refreshing = null;

  /* ---------- token storage ---------- */

  function readAuth() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || null; } catch (e) { return null; }
  }

  function writeAuth(value) {
    auth = value;
    try {
      if (value) localStorage.setItem(AUTH_KEY, JSON.stringify(value));
      else localStorage.removeItem(AUTH_KEY);
    } catch (e) { /* storage blocked: the session lasts until the page reloads */ }
  }

  function storeToken(res) {
    writeAuth({
      access_token: res.access_token,
      refresh_token: res.refresh_token || (auth && auth.refresh_token) || null,
      expires_at: res.expires_in ? Date.now() + res.expires_in * 1000 : null,
      account_id: res.account_id || (auth && auth.account_id) || null
    });
  }

  /* ---------- PKCE helpers ---------- */

  function randomString(length) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    var bytes = window.crypto.getRandomValues(new Uint8Array(length));
    return Array.prototype.map.call(bytes, function (b) { return chars[b % chars.length]; }).join('');
  }

  function base64Url(buffer) {
    var binary = String.fromCharCode.apply(null, new Uint8Array(buffer));
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function codeChallenge(verifier) {
    return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)).then(base64Url);
  }

  /* ---------- errors ---------- */

  function parseBody(xhr) {
    if (xhr.responseJSON !== undefined) return xhr.responseJSON;
    try { return JSON.parse(xhr.responseText); } catch (e) { return null; }
  }

  function friendlyMessage(status, summary, body) {
    if (status === 0) return 'Could not reach Dropbox. Check your internet connection and try again.';
    if (/missing_scope/.test(summary)) {
      var scope = body && body.error && body.error.required_scope;
      return 'This app is missing the Dropbox permission' + (scope ? ' "' + scope + '"' : '') +
        '. Enable it in the Dropbox App Console, then log out and sign in again.';
    }
    if (/insufficient_space/.test(summary)) return 'Your Dropbox is full. Free up some space and try again.';
    if (/invalid_grant/.test(summary)) return 'Your Dropbox sign-in has expired. Please sign in again.';
    if (/redirect_uri/.test(summary)) return 'The redirect URI is not registered for this Dropbox app. Add ' + redirectUri() + ' in the App Console.';
    if (status === 401) return 'Your Dropbox session has expired. Please sign in again.';
    if (status === 429 || /too_many/.test(summary)) return 'Dropbox is busy right now (rate limited). Please wait a moment and try again.';
    if (/not_found/.test(summary)) return 'That file no longer exists in your Dropbox.';
    if (/disallowed_name|malformed_path/.test(summary)) return 'Dropbox does not allow this file name. Rename the file and try again.';
    if (status >= 500) return 'Dropbox is having trouble right now (HTTP ' + status + '). Please try again shortly.';
    return 'Dropbox error: ' + (summary || 'HTTP ' + status);
  }

  function toError(xhr) {
    var body = parseBody(xhr);
    var summary = (body && (body.error_summary || body.error_description ||
      (typeof body.error === 'string' && body.error))) || '';
    if (!summary && typeof xhr.responseText === 'string') summary = xhr.responseText.slice(0, 200);
    var err = new Error(friendlyMessage(xhr.status, summary, body));
    err.status = xhr.status;
    err.summary = summary;
    err.data = body;
    return err;
  }

  function sessionError(message) {
    var err = new Error(message || 'Please sign in with Dropbox.');
    err.authExpired = true;
    return err;
  }

  function expireSession(err) {
    err.authExpired = true;
    err.message = 'Your Dropbox session has expired. Please sign in again.';
    if (auth) {
      writeAuth(null);
      $(document).trigger('dropbox:signedout', [err.message]);
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* ---------- tokens ---------- */

  function tokenRequest(data) {
    data.client_id = cfg.appKey;
    return Promise.resolve($.ajax({ url: TOKEN_URL, method: 'POST', data: data, dataType: 'json' }))
      .catch(function (xhr) { throw toError(xhr); });
  }

  function refreshToken() {
    if (!auth || !auth.refresh_token) {
      var err = sessionError();
      expireSession(err);
      return Promise.reject(err);
    }
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refresh_token })
        .then(function (res) { storeToken(res); return auth.access_token; })
        .catch(function (err) {
          if (err.status >= 400 && err.status < 500) expireSession(err);
          throw err;
        })
        .finally(function () { refreshing = null; });
    }
    return refreshing;
  }

  function getAccessToken() {
    if (!auth) return Promise.reject(sessionError());
    if (auth.expires_at && Date.now() > auth.expires_at - 60000) return refreshToken();
    return Promise.resolve(auth.access_token);
  }

  /* ---------- request plumbing ---------- */

  // build(token) returns $.ajax settings. Handles token refresh, 401s and rate limiting.
  function send(build, attempt) {
    attempt = attempt || 0;
    return getAccessToken().then(function (token) {
      return Promise.resolve($.ajax(build(token))).catch(function (xhr) {
        if (!xhr || typeof xhr.getResponseHeader !== 'function') throw xhr;
        var err = toError(xhr);
        if (err.status === 401 && !/missing_scope/.test(err.summary)) {
          if (attempt === 0 && auth && auth.refresh_token) {
            return refreshToken().then(function () { return send(build, attempt + 1); });
          }
          expireSession(err);
          throw err;
        }
        if ((err.status === 429 || err.status === 503) && attempt < MAX_RETRIES) {
          var wait = parseFloat(xhr.getResponseHeader('Retry-After')) || Math.pow(2, attempt);
          return delay(Math.min(wait, 30) * 1000).then(function () { return send(build, attempt + 1); });
        }
        throw err;
      });
    });
  }

  function rpc(endpoint, args) {
    return send(function (token) {
      return {
        url: RPC_URL + endpoint,
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        contentType: 'application/json',
        data: args === undefined ? 'null' : JSON.stringify(args),
        dataType: 'json'
      };
    });
  }

  // The Dropbox-API-Arg header must be ASCII, so escape everything else as \uXXXX.
  function headerSafeJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, function (c) {
      return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  /* ---------- public API ---------- */

  function isConfigured() {
    return !!cfg.appKey && !/^YOUR_/.test(cfg.appKey);
  }

  function redirectUri() {
    if (cfg.redirectUri) return cfg.redirectUri;
    // "/index.html" and "/" serve the same page, so always send the shorter form;
    // at the domain root that is the bare origin, with no trailing slash.
    var path = window.location.pathname.replace(/index\.html$/, '');
    return window.location.origin + (path === '/' ? '' : path);
  }

  function isSignedIn() {
    return !!auth;
  }

  function beginLogin() {
    if (!isConfigured()) return Promise.reject(new Error('Add your Dropbox app key to js/config.js first.'));
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      return Promise.reject(new Error('Sign-in needs a secure page. Open the app over https:// or http://localhost.'));
    }
    var verifier = randomString(64);
    var state = randomString(24);
    try {
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier: verifier, state: state }));
    } catch (e) {
      return Promise.reject(new Error('Your browser is blocking storage, which sign-in needs. Allow site data and try again.'));
    }
    return codeChallenge(verifier).then(function (challenge) {
      window.location.assign(AUTHORIZE_URL + '?' + $.param({
        client_id: cfg.appKey,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: redirectUri(),
        token_access_type: 'offline',
        scope: SCOPES.join(' '),
        state: state
      }));
    });
  }

  // Completes sign-in when Dropbox redirects back with ?code=… (or ?error=…).
  // Resolves true if a sign-in was completed, false if this was a normal page load.
  function handleRedirect() {
    var query = new URLSearchParams(window.location.search);
    if (!query.has('code') && !query.has('error')) return Promise.resolve(false);

    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(PKCE_KEY));
      sessionStorage.removeItem(PKCE_KEY);
    } catch (e) { /* handled below */ }

    if (query.has('error')) {
      return Promise.reject(new Error(query.get('error') === 'access_denied'
        ? 'Dropbox sign-in was cancelled.'
        : 'Dropbox sign-in failed: ' + (query.get('error_description') || query.get('error'))));
    }
    if (!saved || saved.state !== query.get('state')) {
      return Promise.reject(new Error('The sign-in attempt expired or did not match. Please try again.'));
    }
    return tokenRequest({
      grant_type: 'authorization_code',
      code: query.get('code'),
      code_verifier: saved.verifier,
      redirect_uri: redirectUri()
    }).then(function (res) { storeToken(res); return true; });
  }

  function signOut() {
    var revoke = auth ? rpc('auth/token/revoke').catch(function () {}) : Promise.resolve();
    return revoke.then(function () { writeAuth(null); });
  }

  function getAccount() {
    return rpc('users/get_current_account');
  }

  function getSpaceUsage() {
    return rpc('users/get_space_usage');
  }

  function uploadFile(blob, path, onProgress) {
    return send(function (token) {
      return {
        url: CONTENT_URL + 'files/upload',
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Dropbox-API-Arg': headerSafeJson({ path: path, mode: 'add', autorename: true, mute: true })
        },
        contentType: 'application/octet-stream',
        processData: false,
        data: blob,
        dataType: 'json',
        xhr: function () {
          var xhr = $.ajaxSettings.xhr();
          if (onProgress && xhr.upload) {
            xhr.upload.addEventListener('progress', function (e) {
              if (e.lengthComputable) onProgress(e.loaded / e.total);
            });
          }
          return xhr;
        }
      };
    });
  }

  // Resolves with a public shared link URL, reusing an existing link if there is one.
  function createSharedLink(path) {
    return rpc('sharing/create_shared_link_with_settings', {
      path: path,
      settings: { audience: 'public', access: 'viewer' }
    }).catch(function (err) {
      if (/shared_link_already_exists/.test(err.summary)) {
        var existing = err.data && err.data.error && err.data.error.shared_link_already_exists;
        if (existing && existing.metadata && existing.metadata.url) return existing.metadata;
        return rpc('sharing/list_shared_links', { path: path, direct_only: true }).then(function (res) {
          if (res.links.length) return res.links[0];
          throw err;
        });
      }
      // Some accounts (e.g. team policies) reject explicit settings; fall back to the defaults.
      if (/settings_error/.test(err.summary)) return rpc('sharing/create_shared_link_with_settings', { path: path });
      throw err;
    }).then(function (link) { return link.url; });
  }

  // Resolves with { path_lower: url } for every file shared link the user has.
  function listSharedLinks() {
    var links = {};
    function page(cursor) {
      return rpc('sharing/list_shared_links', cursor ? { cursor: cursor } : {}).then(function (res) {
        res.links.forEach(function (link) {
          if (link['.tag'] === 'file' && link.path_lower) links[link.path_lower] = link.url;
        });
        return res.has_more ? page(res.cursor) : links;
      });
    }
    return page();
  }

  // Resolves with every file entry in the app folder.
  function listFiles() {
    var files = [];
    function collect(res) {
      res.entries.forEach(function (entry) { if (entry['.tag'] === 'file') files.push(entry); });
      return res.has_more ? rpc('files/list_folder/continue', { cursor: res.cursor }).then(collect) : files;
    }
    return rpc('files/list_folder', { path: '', recursive: true, limit: 2000 }).then(collect);
  }

  // Up to 25 paths per call. Resolves with entries in request order.
  function getThumbnails(paths) {
    return send(function (token) {
      return {
        url: CONTENT_URL + 'files/get_thumbnail_batch',
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        contentType: 'application/json',
        data: JSON.stringify({
          entries: paths.map(function (path) {
            return { path: path, format: 'jpeg', size: 'w480h320', mode: 'bestfit' };
          })
        }),
        dataType: 'json'
      };
    }).then(function (res) { return res.entries; });
  }

  function getTemporaryLink(path) {
    return rpc('files/get_temporary_link', { path: path }).then(function (res) { return res.link; });
  }

  function deleteChunk(paths) {
    var jobId;
    function handle(res) {
      switch (res['.tag']) {
        case 'async_job_id':
          jobId = res.async_job_id;
          return delay(800).then(check);
        case 'in_progress':
          return delay(1000).then(check);
        case 'complete':
          return res.entries.map(function (entry, i) { return { path: paths[i], ok: entry['.tag'] === 'success' }; });
        default:
          throw new Error('Dropbox could not delete the selected files. Please try again.');
      }
    }
    function check() {
      return rpc('files/delete_batch/check', { async_job_id: jobId }).then(handle);
    }
    return rpc('files/delete_batch', {
      entries: paths.map(function (path) { return { path: path }; })
    }).then(handle);
  }

  // Resolves with [{ path, ok }] for every path.
  function deleteFiles(paths) {
    var results = [];
    var chunks = [];
    for (var i = 0; i < paths.length; i += DELETE_BATCH_LIMIT) chunks.push(paths.slice(i, i + DELETE_BATCH_LIMIT));
    return chunks.reduce(function (prev, chunk) {
      return prev.then(function () {
        return deleteChunk(chunk).then(function (res) { results = results.concat(res); });
      });
    }, Promise.resolve()).then(function () { return results; });
  }

  window.DropboxClient = {
    isConfigured: isConfigured,
    redirectUri: redirectUri,
    isSignedIn: isSignedIn,
    beginLogin: beginLogin,
    handleRedirect: handleRedirect,
    signOut: signOut,
    getAccount: getAccount,
    getSpaceUsage: getSpaceUsage,
    uploadFile: uploadFile,
    createSharedLink: createSharedLink,
    listSharedLinks: listSharedLinks,
    listFiles: listFiles,
    getThumbnails: getThumbnails,
    getTemporaryLink: getTemporaryLink,
    deleteFiles: deleteFiles
  };
})(window, jQuery);
