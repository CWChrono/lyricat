#!/usr/bin/env node
// One-time helper: mint a Google Drive OAuth **refresh token** for Cat-Jam cloud sync.
//
//   node drive-auth.mjs <client_id> <client_secret> [port]
//
// Needs a "Desktop app" OAuth client (Google auto-allows the http://127.0.0.1 loopback redirect for
// that type). It opens a local server, you click "Allow" in your browser, and it writes the refresh
// token to drive-refresh-token.txt (and prints it). Paste that one value into the Cat-Jam panel.
// No secrets are stored in this file — the client id/secret are runtime arguments only.

import http from "node:http";
import { writeFileSync } from "node:fs";

const [clientId, clientSecret, portArg] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node drive-auth.mjs <client_id> <client_secret> [port]");
  process.exit(1);
}
const PORT = Number(portArg) || 42813;
const redirectUri = `http://127.0.0.1:${PORT}`;
const scope = "https://www.googleapis.com/auth/drive.file";
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force the refresh token even on a repeat authorize
  }).toString();

const OUT = new URL("./drive-refresh-token.txt", import.meta.url).pathname;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (!code && !err) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (err) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<h2>Authorization failed: ${err}</h2>`);
    console.error("Authorization failed:", err);
    server.close();
    process.exit(1);
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    const json = await tokenRes.json();
    if (!json.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>No refresh token returned — re-run and make sure you click Allow.</h2>");
      console.error("Token response had no refresh_token:", JSON.stringify(json));
      server.close();
      process.exit(1);
    }
    writeFileSync(OUT, json.refresh_token + "\n");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<h2>✓ Cat-Jam connected. Close this tab and return to Spotify.</h2>");
    console.log("\n✓ REFRESH TOKEN:\n" + json.refresh_token + "\n\n(also written to " + OUT + ")");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\nAuthorize URL (open in the browser you're logged into Google with), then click Allow:\n");
  console.log(authUrl + "\n");
});
