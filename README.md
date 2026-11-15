# Cubecraft multiplayer on Cloudflare

```
cubecraft/
  wrangler.jsonc      config (Worker + Durable Object + static hosting)
  src/worker.js       the multiplayer server
  public/index.html   the game
```

## Deploy
1. Install Node.js, then in this folder run:  `npx wrangler login`
2. `npx wrangler deploy`
3. Open the `https://cubecraft.<your-subdomain>.workers.dev` URL it prints. Everyone who types the **same lobby name** lands in the same world.

Local test: `npx wrangler dev`, then open http://localhost:8787 in two tabs.

## Using the game file somewhere else
If you open the HTML from your disk or another host, the lobby screen shows a **Server** box: paste `wss://cubecraft.<your-subdomain>.workers.dev`.
You can also hard-code it in `MP_SERVER` near the top of the multiplayer section in the script.

## Notes
- Leave the lobby name blank for solo play (no server needed).
- Open World and Peaceful lobbies are separate even with the same name.
- The server stores block edits and chest contents per lobby (Durable Object storage), so builds survive everyone leaving.
- Not synced: dropped items, furnace contents, mobs/time of day.
