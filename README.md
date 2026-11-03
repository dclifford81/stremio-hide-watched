# Hide Watched Episodes — Stremio addon

Hides the episodes you've already watched in a TV series, wherever they are.
For example, open The Simpsons and only the episodes you haven't seen are listed.
It works in Stremio on Android, Android TV, desktop and web. Movies aren't affected.

- A **Hide Watched** row on the Board lists the series you're watching, e.g.
  "212 unwatched · next S4E7 · 678 watched hidden".
- Searching in Stremio also shows a **Hide Watched** row of results, so you can
  open any series this way.
- **Toggle:** a show's page has a **👁 Show all episodes** link that opens the
  normal page with every episode. Press back to return to the filtered page.
  After you watch more episodes, a **↻ Hide N newly watched** link appears and
  refreshes the page without them.

Streams still come from your usual addons (Torrentio etc.). Episode IDs are
unchanged, so they work as normal.

## How it works / limits

- Stremio addons can't change the app's own show page. This addon serves its own
  copy of each show with the watched episodes removed. The normal page, opened
  from Discover or the regular search results, still shows every episode.
- It reads your library through your Stremio auth key to find out what you've
  watched. It only reads and never writes to your account.
- When you watch an episode from the addon's page, Stremio records progress on
  the addon's copy rather than the original show. The addon combines both, so
  the episode is hidden either way. However, an episode watched only from the
  addon's page won't show as checked on the normal page.
- The addon's copy of a show can also appear in Continue Watching. Opening it
  there opens the filtered page.

## Run it locally

Requires Node 18+. There are no runtime dependencies.

```bash
npm start
```

Open http://127.0.0.1:7000/configure.

```bash
npm install && npm test
```

## Getting it onto your Android phone

Stremio on Android only installs addons from **https** URLs, so the server must
be reachable over HTTPS. Pick one option:

**A. Free hosting (always on).** Push this folder to a GitHub repo. Then on
[render.com](https://render.com) choose **New → Blueprint** and pick the repo.
The included `render.yaml` sets everything up, and you get
`https://<name>.onrender.com`.
On Render's free tier the service sleeps when idle, so the first load after a
while takes about 30 seconds.

**B. Run it on your PC and tunnel it (good for trying it out).**

```bash
npm start
```

```bash
cloudflared tunnel --url http://localhost:7000
```

`cloudflared` prints an `https://….trycloudflare.com` URL. That URL changes every
time you restart the tunnel, and the PC has to stay on.

Then, **on the phone**:

1. Open `https://<your-host>/configure` in the phone's browser.
2. Log in with your Stremio email and password. The server exchanges them for an
   auth key and doesn't store them. If you sign in with Google or Facebook,
   paste your auth key instead (see below).
3. Tap **Install in Stremio**. The Stremio app opens and asks to install. If it
   doesn't, tap **Copy addon URL**, then in Stremio go to Addons → search box →
   paste the URL.
4. The **Hide Watched** row appears on the Board, and in search results.

On a computer using https://web.stremio.com, use **Install on Stremio Web**
instead. The `stremio://` link behind "Install in Stremio app" only opens the
installed apps. Addons sync through your Stremio account, so installing it once
on any device usually puts it on the others too.

### Getting your auth key (Google/Facebook logins)

1. Log in at https://web.stremio.com on a computer.
2. Open the browser console (F12) and run:

```js
JSON.parse(localStorage.getItem("profile")).auth.key
```

That key belongs to that browser's login session, and **logging out there kills
it**. When that happens, the row turns into a "⚠ Reconnect Hide Watched" card.
To avoid it, get the key from a browser you stay logged in to. Or log in to
web.stremio.com in a private window, copy the key, and close the window without
logging out. The email/password button on the setup page creates its own
session, so ordinary logouts on your devices don't affect it.

## Security note

The addon URL contains your auth key, which gives full access to your Stremio
account. Don't share the URL, and host the addon yourself rather than on a
public instance. Logging out of all sessions in Stremio invalidates the key.
Generate a new addon URL after that.
