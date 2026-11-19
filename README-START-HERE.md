# Held v10.6 – TURN setup for two MacBooks on different networks

Evidence from chrome://webrtc-internals: signaling stable, ICE connection state failed, STUN-only.
This adds TURN credential fetching without changing Supabase/video-track logic, interaction, or visual design.

## 1) Get a credential
Open https://dashboard.metered.ca/ and create an account.
TURN Server -> Credentials -> Create Credential.
Get credential -> Show API Key (credential-specific, NOT Developers Secret Key).
The Metered Domain is under Developers, e.g. yourapp.metered.live.

## 2) Edit turn-config.js
Set credentialUrl to:
  https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_CREDENTIAL_API_KEY
Keep forceRelay: true for the initial cross-network test to ensure a relay really works. If credentialUrl is empty, the app uses the original STUN-only behavior instead of erroneously forcing relay with no TURN credentials.
Do NOT commit or share an account-wide secret API key. Metered's credential-specific API key is allowed in frontend use, but it is visible to site visitors and may consume quota. Set limits and rotate/revoke when finished.

## 3) Deploy
Back up your current site. Replace app.js and index.html with these files; include the new turn-config.js in the same folder. Use the existing style.css, config.js and palette.js. (Included style.css is the matching v10.5 layout version.) Upload the entire folder. Your Netlify team is now on Pro, so you can deploy to the existing Netlify site (assuming your dashboard shows deploys enabled).

## 4) Test
Use a NEW Held room. Both sides must open the newly published version. In Chrome console:
  window.HELD_TURN_BUILD => "v10.6-metered-turn"
  window.HELD_TURN_STATUS => "READY"
If no API key entered, status explicitly says STUN ONLY. If credentials fail, a TURN setup failure is shown instead of silently claiming the relay exists.
With forceRelay=true, check chrome://webrtc-internals -> selected candidate pair should include relay and connection state connected. If failed, inspect provider credentials / network access.

Static syntax validated; external TURN service and two Macs have NOT been tested in this environment.

Note: Netlify Pro and Metered TURN are separate services and separate billing/usage. The package does not contain a TURN account or working credentials. Both participants need to reopen the newly deployed version (preferably in a new room).
