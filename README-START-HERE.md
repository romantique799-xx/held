# Held v10.5 — Layout corrections from annotated screenshots

This is a VISUAL-ONLY patch based on v10.4. It does not include or replace `app.js`, `config.js`, `palette.js`, Supabase policies, or hand-tracking code.

## Exactly what changed

1. The room-info / waiting / invite bar is no longer displayed on the JOIN page. The room, role and peer-status nodes remain in the DOM so the existing JS can keep updating them.
2. The existing **02 copy invite link** button was MOVED (not duplicated) into the Studio right column, above the supplied TWO HANDS art, flush-left with the art. Original button `id=copyLinkBtn` and JS handler are unchanged.
3. The supplied THREE-D TWO HANDS artwork replaces the extra text heading. Instructions, two-person feedback, status, controls and stage navigation remain available.
4. The link bar no longer appears in the MEMORY page either; the right preview panel is inset and rounded with the same #F5EFF1 treatment as the Studio stage, with vertical breathing room.
5. Spacing was opened up in the Studio right column, responsive adjustments included for iPad landscape and narrow screens.
6. CSS link cache-busted to v10.5. No external asset folder is needed; supplied transparent artwork remains embedded in index.html.

## Deploy

Keep your current working site folder. Replace ONLY `index.html` and `style.css` with the files in this ZIP. Keep your existing `app.js`, `config.js`, `palette.js`, and any other files completely unchanged. Upload the complete folder to your hosting platform after deploys are available.

## Verification and limits

Static previews checked with Chromium at desktop (1600×950, 2048×1057), iPad landscape (1024×768), and phone (390×844). All 76 original DOM element IDs are retained, and the original copy-link button has just moved. The real Supabase/WebRTC/hand-tracking behavior was not live-tested against two devices in this build.
