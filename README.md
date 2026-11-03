# Hide Watched Episodes — Stremio addon

Adds an **Up Next (unwatched)** row to Stremio (Android, Android TV, desktop, web).
Every show you're watching appears there, labelled with the next episode
(e.g. "Next: S2E5 · 7 unwatched"). Opening a show from this row lists only the
episodes from your next unwatched one onward, so there's no scrolling past
seasons you've already finished.

Streams still come from your usual addons (Torrentio etc.). Episode IDs are
unchanged, so they work as normal.

## How it works / limits

- Stremio addons can't change the app's own show page. This addon serves its own
  copy of each show (ID `hw:tt…`) with the watched episodes removed. The normal
  Cinemeta page, opened from search or Discover, still shows every episode.
- It reads your library through your Stremio auth key to find out what you've
  watched. It only reads and never writes to your account.
- What's hidden is "everything before your first unwatched episode". If you skip
  around, a watched episode after that point stays visible, with a checkmark.
- Specials (season 0) are left out.
- When you watch an episode from this addon's page, Stremio records progress on
  the `hw:` item rather than the original show. The addon combines both, so the
  episode is hidden either way. However, an episode watched only from this page
  won't show as checked on the normal Cinemeta page. The `hw:` item may also
  appear in Continue Watching, which is fine because it opens the filtered page.

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

**A. Free hosting (always on).** Push this folder to a GitHub repo, then on
[render.com](https://render.com) create a *Web Service* from it with
Build `npm install` and Start `npm start`. You get `https://<name>.onrender.com`.
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
4. The **Up Next (unwatched)** row appears on the Board.

### Getting your auth key (Google/Facebook logins)

1. Log in at https://web.stremio.com on a computer.
2. Open the browser console (F12) and run:

```js
JSON.parse(localStorage.getItem("profile")).auth.key
```

## Security note

The addon URL contains your auth key, which gives full access to your Stremio
account. Don't share the URL, and host the addon yourself rather than on a
public instance. Logging out of all sessions in Stremio invalidates the key.
Generate a new addon URL after that.
