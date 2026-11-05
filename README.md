# Rally — Badminton Tournament Manager

A self-hosted badminton tournament manager with dynamic player registration, fixed or rotating doubles partners, automatic fixture generation, shared live scoring, a public spectator scoreboard, player statistics and Player of the Match approval.

## Requirements
- Node.js 18 or newer
- npm

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000

## Demo access PINs
- Organizer: `2468`
- Authorized scorer: `1357`

Change these before using the app outside a trusted local network:
```bash
ADMIN_PIN=your-admin-pin SCORER_PIN=your-scorer-pin PORT=3000 npm start
```

## Spectator screen
Open http://localhost:3000/?view=public on a TV, tablet or spectator phone. It is read-only and receives live updates over WebSocket.

## Included features
- Dynamic player directory with profile photo upload (2 MB per photo)
- Tournament setup with selected participants
- Fixed teams (random draw or registration order)
- Rotating doubles partners with round-by-round pair generation and bye rotation
- Round-robin / league fixtures for fixed teams; initial knockout round generation
- Live score controls: +1, −1, undo, automatic save and WebSocket broadcast
- Best-of-three scoring, 21 points, win by two, cap at 30
- Organizer and scorer access roles
- Individual leaderboard, player statistics and POTM suggestions
- Organizer approval of POTM and tournament history

## Notes / limitations for this starter release
- The default PIN authentication is suitable for a trusted LAN demo, not public internet deployment. Use HTTPS, stronger authentication, secure sessions and a database before exposing it publicly.
- Data is persisted in `data/tournament.json`. Back up this file regularly.
- Photos are stored as data URLs in the JSON file; use object storage for a larger deployment.
- Knockout currently generates the opening round. A production bracket should advance winners automatically into subsequent rounds; that is a sensible next enhancement.
- Rotating partner schedules are generated using randomized pair combinations and a simple partner-repeat avoidance heuristic. For larger groups, a full round-robin partner scheduler can improve fairness further.
- MVP is a transparent heuristic based on wins, POTM awards, win rate and point differential; organizer approval/override can be added if desired.

## Network access
To let phones on the same Wi-Fi access the app, run the server on a computer connected to that network and open `http://<computer-LAN-IP>:3000` from the phones. Ensure the computer firewall allows inbound TCP port 3000. All devices must be able to reach that computer.
