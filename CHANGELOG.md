# Changelog
## 1.6.1 (unreleased)
* [Security] Replaced the deprecated `request` package (unpatched SSRF advisory plus vulnerable `form-data`, `tough-cookie`, `qs`, `uuid`) with a small built-in HTTP client (`src/http.js`) on Node's `http`/`https` and `tough-cookie` 6. Redirects are only followed for GET/HEAD and only to http(s) URLs, the Host header is derived per hop, multipart field names are escaped, boundaries use `crypto.randomBytes`, and response bodies are capped at 64 MB. Requests with no jar no longer fall back to a process-wide shared cookie jar.
* [Security] Replaced `websocket-stream` (bundled `ws@3`, DoS advisories) with `ws@8` (`src/websocket.js`); upgraded `mqtt` 3 → 5 and `cheerio` 0.22 → 1.2. `npm audit` reports 0 vulnerabilities.
* [Security] `mobile_device.json` is now written owner-only (0600), like `e2ee_device.json`.
* [Fix] End-to-end encrypted messages sent within the same second could show up out of order: their IDs were random numbers, while Messenger's clients use (milliseconds << 22) | random bits and recipients order same-second messages (the server timestamp has one-second resolution) by it. Outgoing IDs now use that format and strictly increase.
* [Fix] `listenMqtt` reported `Cannot read properties of undefined (reading 'successful_results')` when Facebook answered the sync sequence-ID request with an empty payload (which it does for a session it has started limiting, often after many logins in a short time). It now reports that clearly.
* [Fix] The messaging and call MQTT clients retried a dropped connection every second for as long as it stayed down. The delay now doubles after each attempt, up to a minute, and resets once connected.
* [Fix] Sending more than one message per `listenMqtt` session failed with "failed to publish request": Facebook acks with reserved MQTT header flag bits set, which `mqtt-packet` 9 rejects by dropping the connection. The MQTT clients now use `websocket.mqtt`, which resets those bits (tracking packet boundaries across websocket messages) before parsing.
* [Performance] appState logins get the CSRF token (`fb_dtsg`) from the small `/ajax/dtsg/` endpoint (~150ms) instead of waiting for the ~1 MB homepage app shell (0.5s or more); LSD and the client revision are filled in from the homepage in the background, and the homepage is used as before if the endpoint answers unexpectedly. Start to logged in went from about 0.65s to 0.35s.
* [Performance] Faster login (about 1.4s → 0.65s from start to logged in with an appState, measured live): each `api.<function>` is now loaded on first use instead of requiring all of `src/` (plus the E2EE and call stacks) at login; the legacy `presence/reconnect.php` ping is sent in the background instead of adding a round trip before the login callback; `cheerio` and `tweetnacl-sealedbox-js` (password/approval login only) and `mqtt` (loaded when a connection opens) are no longer required up front.
* [New] [setOptions](/DOCS.md#setOptions): `e2eeDeviceListCacheMs` (default `0`, off) lets encrypted sends reuse a user's device list for that long instead of fetching it every time (a server round trip, about 0.6s). A device added while the list is cached misses those messages; the cache for a chat is dropped when a send to it fails or the server reports a device change.
* [Performance] Faster end-to-end encrypted sends. XEdDSA signature checks use Node's native Ed25519 and signing uses extended-coordinate point math (about 1.1s → 3ms and 1.9s → 9ms), prekey bundles for all of a contact's devices are fetched in one request (falling back to one per device), and connecting no longer waits for the prekey count check. A first message to a contact went from about 15s to 2s; later messages take one device-list round trip (about 0.6s).
* [Breaking] [Security] Requires Node.js 22.23.2 or newer (the 2026-07-28 security release). Node 20 is end-of-life, and older 20.x/22.x releases carry known CVEs (HTTP/2 DoS, TLS callback crashes, HMAC timing leak, permission-model bypasses).
* [Dev] ESLint 10 (flat config in `eslint.config.js`), Mocha 12, and offline unit tests for the HTTP/WebSocket layer (`npm run test:unit`).
* [New] [call](/DOCS.md#call) / [acceptCall](/DOCS.md#acceptCall) / [declineCall](/DOCS.md#declineCall) / [endCall](/DOCS.md#endCall) / [getCalls](/DOCS.md#getCalls) / [connectCalls](/DOCS.md#connectCalls): Messenger call control (start, answer, decline, hang up, call events through listenMqtt) via the native "Multiway"/Zenon signaling protocol. `options.media` adds real two-way WebRTC audio (WAV files or PCM callbacks) through the optional `@roamhq/wrtc` (preferred) or `werift`/`opusscript` engines; Facebook's TURN relays are fetched automatically, the client subscribes to the conference's dominant-speaker stream and answers the SFU's renegotiation offers; the audio file is held until the peer joins and then starts after `media.audioDelayMs` (default 3s); E2EE one-to-one calls build their `E2eeState` automatically from the library's E2EE device, sign the DTLS handshake (`a=x-dtls-auth`) with Meta's frame-encryption wasm, trade `E2eeKey` messages and encrypt the media frames (SFrame), so 1:1 E2EE calls carry real audio too; `media.opusBitrate` (default 128000, also settable with `api.setOptions`) sets the Opus encoder bitrate, and the audio clock is drift-corrected so playback runs at true real-time on Windows
* [New] [downloadE2EEAttachment](/DOCS.md#downloadE2EEAttachment): download and decrypt the media of an end-to-end encrypted attachment received from listenMqtt
* [New] [sendMessage](/DOCS.md#sendMessage): attachments (images, videos, audio, files) are now sent end-to-end encrypted on encrypted one-to-one chats (media-key encryption, upload to Facebook's encrypted media service, transport protobufs in the Signal message); incoming E2EE attachments are delivered in `message.attachments`; group E2EE (sender keys) is still unsupported
* [New] [searchMessages](/DOCS.md#searchMessages): Search messages in a chat (regular or restored end-to-end encrypted) by paging through getThreadHistory
* [New] [restoreE2EEBackup](/DOCS.md#restoreE2EEBackup): Restore the encrypted backup ("Secure Storage") natively with the 40-character recovery code (fetches and decrypts the virtual device secrets, derives epoch keys with Meta's Labyrinth WASI module, and stores the state in the E2EE device file)
* [New] [getThreadHistory](/DOCS.md#getThreadHistory): end-to-end encrypted one-to-one chats return messages decrypted from the restored backup when available
* [New] [createGroup](/DOCS.md#createGroup): Create a Facebook Group
* [New] [createGroupPost](/DOCS.md#createGroupPost): Post to a Facebook Group
* [New] [getGroupPosts](/DOCS.md#getGroupPosts): Read posts from a Facebook Group
* [New] Cursor pagination for [getGroupPosts](/DOCS.md#getGroupPosts), [getFeed](/DOCS.md#getFeed) and [getPostComments](/DOCS.md#getPostComments) (`options.cursor` + `pageInfo` callback argument)
* [New] Cursor pagination for [getGroupEvents](/DOCS.md#getGroupEvents) and [getGroupFiles](/DOCS.md#getGroupFiles) (`options.cursor` + `pageInfo` callback argument)
* [New] [getPostReactions](/DOCS.md#getPostReactions): accepts `options.cursor` and returns `pageInfo`
* [New] [getGroupMedia](/DOCS.md#getGroupMedia): Read photos/videos from a group's Media tab
* [New] [getGroupMembers](/DOCS.md#getGroupMembers) / [searchGroupMembers](/DOCS.md#searchGroupMembers): Read/search group members
* [New] [searchGroupPosts](/DOCS.md#searchGroupPosts): Search posts inside a group
* [New] [getPostComments](/DOCS.md#getPostComments): Read a post's comments
* [New] [getPostReactions](/DOCS.md#getPostReactions): List who reacted to a post
* [New] [editGroupPost](/DOCS.md#editGroupPost) / [deleteGroupPost](/DOCS.md#deleteGroupPost): Edit/delete a post
* [New] [pinGroupPost](/DOCS.md#pinGroupPost) / [unpinGroupPost](/DOCS.md#unpinGroupPost): Pin/unpin a post
* [New] [updateGroup](/DOCS.md#updateGroup): Update a group's name/description
* [New] [updateGroupDiscoverability](/DOCS.md#updateGroupDiscoverability): Show/hide a group in search
* [New] [getGroupInfo](/DOCS.md#getGroupInfo): Read a Facebook Group's info
* [New] [getGroupEvents](/DOCS.md#getGroupEvents): Read a group's events
* [New] [getGroupFiles](/DOCS.md#getGroupFiles): Read a group's shared files
* [New] [joinGroup](/DOCS.md#joinGroup) / [leaveGroup](/DOCS.md#leaveGroup): Join/leave a Facebook Group
* [New] [inviteToGroup](/DOCS.md#inviteToGroup): Invite users to a Facebook Group
* [New] [approveJoinRequest](/DOCS.md#approveJoinRequest) / [declineJoinRequest](/DOCS.md#declineJoinRequest): Handle join requests
* [New] [removeGroupMember](/DOCS.md#removeGroupMember): Remove a group member
* [New] [blockGroupMember](/DOCS.md#blockGroupMember): Ban a member from a group
* [New] [getGroupRules](/DOCS.md#getGroupRules): Read a group's rules
* [New] [followGroup](/DOCS.md#followGroup) / [unfollowGroup](/DOCS.md#unfollowGroup): Follow a Facebook Group
* [New] [markGroupVisited](/DOCS.md#markGroupVisited): Clear a group's unread badge
* [New] [getFeed](/DOCS.md#getFeed): Read posts from the home news feed
* [New] [createComment](/DOCS.md#createComment): Comment on a post (supports replies)
* [New] [editComment](/DOCS.md#editComment) / [deleteComment](/DOCS.md#deleteComment): Edit/delete a comment
* [New] [setPostReaction](/DOCS.md#setPostReaction) / [likePost](/DOCS.md#likePost): React to a post
* [New] [setCommentReaction](/DOCS.md#setCommentReaction): React to a comment
* [New] [changeAdminStatus](/DOCS.md#changeAdminStatus): Function to add/remove admins in group threads ([#659](https://github.com/Schmavery/facebook-chat-api/pull/659))

## 1.5.0
* [Fix] Logging in using login approvals (2FA) now work ([#548](https://github.com/Schmavery/facebook-chat-api/pull/548))
* [New] [listen](/DOCS.md#listen): Adds field `mentions` that stores an array of ids of users tagged in the message ([#510](https://github.com/Schmavery/facebook-chat-api/pull/510))
* [Breaking change] [getThreadList](/DOCS.md#getThreadList): Removes deprecated fields in returned object, adds some new fields ([#488](https://github.com/Schmavery/facebook-chat-api/pull/488))
* [Breaking change] [getThreadInfo](/DOCS.md#getThreadInfo): Removes deprecated fields in returned object, adds some new fields ([#488](https://github.com/Schmavery/facebook-chat-api/pull/488))
* [New] [getEmojiUrl](/DOCS.md#getEmojiUrl): Adds utility function for getting the image URL for a Messenger-style emoji ([#477](https://github.com/Schmavery/facebook-chat-api/pull/477))
* [Breaking change] [changeThreadColor](/DOCS.md#changeThreadColor): Due to Facebook backend changes, the thread color can no longer be set to an arbitrary hex value. Color validation and `api.threadColors` have been added to facilitate this change ([#512](https://github.com/Schmavery/facebook-chat-api/pull/512))
* [getThreadHistory](/DOCS.md#getThreadHistory): Fix crash when the author of an old message is no longer available ([#521](https://github.com/Schmavery/facebook-chat-api/pull/521))
* [New] [message](/DOCS.md#message): Adds field `isUnread` that represents whether or not the message was read ([#519](https://github.com/Schmavery/facebook-chat-api/pull/519))

## 1.4.0 (2017-04-28)
* [Breaking change] [getThreadHistory](/DOCS.md#getThreadHistory): update parameters - no more start & end params; replaced with amount ([#453](https://github.com/Schmavery/facebook-chat-api/pull/453))
* [New] [setMessageReaction](/DOCS.md#setMessageReaction): set reaction on message ([#427](https://github.com/Schmavery/facebook-chat-api/pull/427), [#437](https://github.com/Schmavery/facebook-chat-api/pull/437), [#445](https://github.com/Schmavery/facebook-chat-api/pull/445))
* [New] [forwardAttachment](/DOCS.md#forwardAttachment): send attachment to array of users ([#435](https://github.com/Schmavery/facebook-chat-api/pull/435))
* [setMessage](/DOCS.md#sendMessage): added Mentions field ([#460](https://github.com/Schmavery/facebook-chat-api/pull/460))
* [sendTypingIndicator](/DOCS.md#sendTypingIndicator): make callback optional ([#457](https://github.com/Schmavery/facebook-chat-api/pull/457))
* [getUserID](/DOCS.md#getUserID): returns all results instead of just users; callback obj array now includes a type (generally user, group, page, event or app) ([#459](https://github.com/Schmavery/facebook-chat-api/pull/459))
* [Internal] Async function support ([#425](https://github.com/Schmavery/facebook-chat-api/pull/425))

## 1.3.0 (2017-04-01)
* [New] [changeBlockedStatus](/DOCS.md#changeBlockedStatus): combines blockUser & unblockUser functions ([#369](https://github.com/Schmavery/facebook-chat-api/pull/369))
* [changeThreadColor](/DOCS.md#changeThreadColor): callback is now optional ([#367](https://github.com/Schmavery/facebook-chat-api/pull/367))
* [Internal] [getThreadHistory](/DOCS.md#getThreadHistory): callback arrays will be error filtered before returned ([#360](https://github.com/Schmavery/facebook-chat-api/pull/360))

## 1.2.0 (2016-08-18)
* [New] [muteThread](/DOCS.md#muteThread): mute a chat for a period of time, or unmute a chat ([#295](https://github.com/Schmavery/facebook-chat-api/pull/295))
* [New] [handleMessageRequest](/DOCS.md#handleMessageRequest): accept or ignore message request(s) ([#301](https://github.com/Schmavery/facebook-chat-api/pull/301))
* [getThreadList](/DOCS.md#getThreadList): optional type argument; can be 'inbox', 'pending', or 'archived'. Inbox is default ([#301](https://github.com/Schmavery/facebook-chat-api/pull/301))
