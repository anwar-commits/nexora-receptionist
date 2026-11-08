# Put DOC-RECEPTIONIST online (Render, Singapore)

This is a staging/pilot setup: one service runs the API and the web app, plus a private PostgreSQL database.
Approximate cost: two Starter instances plus small disks, roughly USD 15–20 a month (see render.com/pricing).

## 1. Create it (about 10 minutes, mostly waiting)
1. Go to **render.com** → sign in with GitHub (allow access to `anwar-commits/nexora-receptionist`).
2. **New → Blueprint** → choose `nexora-receptionist` → Render reads `render.yaml`.
3. It asks for three values:
   - `ANTHROPIC_API_KEY` — your Anthropic key
   - `ELEVENLABS_API_KEY` — your ElevenLabs key
   - `ELEVENLABS_WEBHOOK_SECRET` — leave empty for now (step 3)
4. **Apply.** When both services show "Live", open **https://doc-receptionist.onrender.com**.
   If Render gave the service a different address, put that address in `PUBLIC_API_URL` and `WEB_ORIGIN`
   (service → Environment) and save.

## 2. Create your clinic
Open the address → **Register** → your clinic. Sign-in codes sent "by SMS" appear in the service's **Logs** tab
(there is no real SMS provider until Phase 13). Then set up doctors, hours and services as before.

## 3. Connect ElevenLabs' post-call webhook
ElevenLabs → **Agents → Settings → Post-call webhook**: URL
`https://doc-receptionist.onrender.com/v1/voice/elevenlabs/post-call`, with transcripts and audio turned on.
Copy the secret it shows → Render → service → Environment → `ELEVENLABS_WEBHOOK_SECRET` → Save.

## 4. Go live (inside the app, Settings → AI Receptionist)
1. **Set up** → check the settings → **Save**.
2. A doctor or you approve the **emergency protocol**.
3. **Run the 40 safety checks** → **Go live** on the version that passed 40/40.
   (Needs credit on the Anthropic account; without it the 5 model checks fail.)
4. **Phone numbers → Add a number → Twilio**: the number, Account SID and Auth Token.
5. Call the number.
