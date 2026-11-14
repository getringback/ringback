# Ringback privacy policy

Updated 12 November 2026. This covers the Ringback Android app and computer plugin, maintained by the getringback project.

## Connections and speech

There is no Ringback-operated server for your calls. Your phone is the hub. Your computers connect to it over your local network or your own Tailscale network. Paired connections use encrypted TLS connections and pairing keys. Tailscale may use its coordination and encrypted relay services.

Speech recognition and the speaking voice run on the phone. What you say is transcribed and sent to the AI session on your computer. That session may send it, and images you share, to its AI provider under your existing settings. If you enable Cloud apps, approved cloud assistants receive your replies directly through the phone's Tailscale Funnel endpoint. People you add to a call receive call audio and conversation text.

Voice models are downloaded from GitHub. Optional voice reference recordings come from Hugging Face. These services receive normal download requests, including your network address. Tailscale receives the account and device information needed for its networking features.

## Permissions and local storage

The microphone is used when you tap to start a call or voice lobby, or answer a call, including while connecting. Camera capture starts from a visible call screen or after you approve a photo request. The call camera setting can allow an agent to take photos while the call screen is open. Continued capture needs Keep looking. Phone screen sharing requires your tap and Android's capture consent. Ringback does not listen or capture your surroundings while waiting for calls.

The phone keeps call history and text transcripts, cards, session and contact details, pairing credentials, settings, downloaded voices and images shared during calls. Call records older than 90 days are pruned when the app starts. Private camera images expire according to Camera settings, 24 hours by default; cleanup runs while the service runs. Screen images are held temporarily in memory and cleared when sharing ends. Camera photos are also saved to the gallery's Ringback album. Computer screen recordings you choose to save can remain on the phone or computer.

## Deletion

Remove cards from the feed. In Settings, Camera, use Delete all photos now to remove private camera copies; the photo log remains. Delete gallery photos and saved recordings separately in your gallery or files app. Gallery or device backups may retain copies according to your system settings.

Remove a computer in Settings, Computers to revoke its access. Remove paired people in People. To erase all Ringback app data, including transcripts, cards, logs and credentials, use Android Settings, Apps, Ringback, Storage, Clear storage. This also removes pairing and downloaded voices. It does not erase gallery media, backups or copies already sent elsewhere.

The plugin keeps pairing credentials, local state, logs and cached images on your computer. Remove its local Ringback data when you stop using it. Delete AI session history and provider copies through that tool or provider; clearing the phone cannot delete them.

Ringback contains no ads or analytics and does not sell your data.

Privacy questions: [getringback/ringback GitHub issues](https://github.com/getringback/ringback/issues). Issues are public; do not include private transcripts or pairing credentials.
