# Hide Watched Episodes — Stremio addon

Hides the episodes you've already watched in a TV series, wherever they are.
For example, open The Simpsons and only the episodes you haven't seen are listed.
It works in Stremio on Android, Android TV, desktop and web. Movies aren't affected.

- A **Continue Watching (unwatched only)** row on the Board lists the series
  you're watching, most recent first, e.g.
  "212 unwatched · next S4E7 · 678 watched hidden". Stremio orders addon rows by
  install order, so a new install starts at the bottom. **Move the row to the
  top** on the setup page puts it right under Continue Watching (and removes
  older copies of the addon). Open the setup page from the addon's ⚙ Configure
  button in Stremio, so it reuses the installed login; logging in again can end
  the session the installed addon uses.
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
Render's free tier puts idle services to sleep, and waking takes about a minute.
To avoid that, the server pings its own Render URL every 10 minutes. One
always-on service fits in the free tier's 750 hours a month. If you run other
free services in the same Render workspace, set the `KEEP_AWAKE` environment
variable to `0` to turn this off.

**B. Docker / Portainer (your own server).**

1. In Portainer go to **Stacks → Add stack → Repository**. Enter this repo's
   URL, reference `refs/heads/main` and compose path `docker-compose.yml`. For a
   private repo, turn on **Authentication** and use your GitHub username plus a
   personal access token with read access to the repo.
2. Deploy. Portainer builds the image and runs it on port 7000.
3. Give it an **https** address. Stremio won't install addons from plain http
   addresses, except on the same machine:
   - **A certificate you already have** (LAN only, no proxy): set `TLS_CERT` and
     `TLS_KEY` to the PEM files and the addon serves https itself, reloading
     the files every 6 hours for renewals. For Home Assistant OS with the Duck
     DNS add-on, see the variables at the top of `docker-compose.yml`. A lighter
     alternative is to run `node:22-alpine` with the command
     `wget -qO- https://codeload.github.com/dclifford81/stremio-hide-watched/tar.gz/refs/heads/main | tar xz --strip-components=1 && exec node src/server.js`
     (working dir `/app`). It downloads the code on every start, so restarting
     the container updates it.
   - **Reverse proxy you already run** (Nginx Proxy Manager, Traefik, Caddy):
     proxy a hostname to `http://<server>:7000`.
   - **Cloudflare Tunnel** (no ports to open): create a tunnel in Cloudflare
     Zero Trust → Networks → Tunnels and set its public hostname's service to
     `http://hide-watched:7000`. Then add two environment variables to the
     stack: `TUNNEL_TOKEN=<token>` and `COMPOSE_PROFILES=tunnel`.
4. Open `https://<your-hostname>/configure` and install from there.

The container keeps no state. To update it, use **Pull and redeploy** on the
stack, or turn on GitOps updates.

**C. Run it on your PC and tunnel it (good for trying it out).**

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
4. The **Continue Watching (unwatched only)** row appears on the Board, and a
   **Hide Watched** row appears in search results.

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
