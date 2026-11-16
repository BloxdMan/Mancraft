# Bloxd man's Mancraft

```
mancraft/
  wrangler.jsonc      config (Worker + Durable Object + static hosting)
  src/worker.js       the multiplayer server
  public/index.html   the game
```

## Notes
- Leave the lobby name blank for solo play (no server needed).
- Open World and Peaceful lobbies are separate even with the same name.
- The server stores block edits and chest contents per lobby (Durable Object storage), so builds survive everyone leaving.
- Not synced: dropped items, furnace contents, mobs/time of day.
