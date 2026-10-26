/*
 * ShotShare configuration.
 *
 * appKey      – the "App key" from your app in the Dropbox App Console
 *               (https://www.dropbox.com/developers/apps). PKCE is used, so the
 *               app secret is never needed and must NOT be put here.
 * redirectUri – leave empty to build it from the address the app is opened at:
 *               the origin alone for a site at the domain root (e.g.
 *               "https://shots.example.com"), or origin + folder for a subfolder
 *               (e.g. "https://example.com/shotshare/"). The sign-in page shows the
 *               value in use; it must be listed under "Redirect URIs" in the App Console.
 *               Set it only to force one fixed address.
 */
window.SHOTSHARE_CONFIG = {
  appKey: '4gce6ji4zka4xp7',
  redirectUri: 'https://santosh-cispl.github.io/ShotShare',
  maxConcurrentUploads: 2
};
