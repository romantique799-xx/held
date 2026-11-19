HELD v10.3 - IMAGE LOADING FIX (self-contained image sources)

WHY: The earlier page referenced ./assets/held-hero.png, held-join.png, held-two-hands.png, and held-memory.png. If assets/ did not reach the deployed site at the site root, the browser displayed broken-image icons.

WHAT CHANGED: ONLY those 4 img src locations. PNG bytes are embedded in index.html. No changes to app.js, style.css, video, hand tracking, Supabase, room logic, or export.

DEPLOY:
1. Open your existing FULL WORKING Held site folder on the Mac (one containing index.html, app.js, style.css, config.js, palette.js).
2. Replace only index.html with the index.html from this ZIP. Do not change the others.
3. Drag the ENTIRE site folder into Netlify's Drop new files. Make sure index.html is at the root of the uploaded folder.
4. Open production site and hard-refresh (Mac Cmd+Shift+R; iPad open new private tab / reload).
5. Check hero, JOIN, TWO HANDS, MEMORY all display.

The embedded image source is 1.65 MB and does not need a separate assets/ folder. You may keep your old assets/ folder without issue.
