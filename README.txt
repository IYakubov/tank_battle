TANK WAR — Shared Couch edition
===============================

A 2-player tank battle. One big screen (PC, TV, laptop) shows the battle;
two players drive their tanks from their phones.

SETUP
  npm install
  npm start
  -> open http://localhost:3000 on the big screen

MODES
  1 PLAYER · VS BOT  one phone against a computer-controlled tank. The bot
                     finds paths around the rocks, aims bank shots off rocks
                     and edges, dodges incoming shells and grabs crates.
  2 PLAYERS          two phones, head to head.

PLAY
  1. On the big screen click 1 PLAYER or 2 PLAYERS. A QR code appears.
  2. Each player scans the QR code with the phone camera (phone must be on
     the same Wi-Fi). The controller opens and joins automatically.
     First phone = Player A (graphite tank), second = Player B (navy tank).
  3. Press READY (both players in 2-player mode), turn the phone to
     landscape, and the battle starts.

  The QR code is generated locally by the server and points at this
  computer's LAN address, so it works even if the big screen was opened
  as "localhost". No internet needed — the Unbounded font ships in
  public/fonts.

CONTROLS (phone)
  D-pad up/down = drive forward/back, left/right = turn
  Round button = one shot per tap (shell leaves from the barrel tip)

MENUS FROM THE PHONE
  When the big screen shows buttons (Next round / Back to lobby), the
  phones drive them: arrows move the highlight, FIRE presses it.
  "Back to lobby" keeps both phones connected; press Ready for a new match.

RULES
  First to 3 round wins. 5 HP each. Shells ricochet off rocks and the arena edge 3 times,
  then burst; after one bounce they can hit their own tank.
  Powerups: Shield (blocks one hit), Repair (+1 HP), Pierce (next shot
  goes through rocks). One shot, then a 1.8 s reload shown in the top bar.

FILES
  server.js               rooms, lobby, input relay, QR generation
  public/index.html       big screen (game, physics, rendering, sounds)
  public/controller.html  phone controller
  public/fonts/           Unbounded variable font (OFL licence)
