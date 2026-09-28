# fbapi-unofficial

An unofficial Node.js API for Facebook Messenger and Facebook Groups that works on a regular user account.

This is a maintained fork of [Schmavery/facebook-chat-api](https://github.com/Schmavery/facebook-chat-api), which is in maintenance mode. It keeps the original API and adds what the current Facebook web client needs: end-to-end encrypted one-to-one chats, the LightSpeed/MQTT send path, Messenger calls, and Groups/feed functions.

> **Read this first.** The library works by emulating the Facebook website: it sends the same requests, cookies and tokens a browser would. It is not an official API, it can break overnight when Facebook changes something, and automating a personal account can get it checkpointed or banned. Don't spam, don't message people you don't know, and don't send messages in fast bursts. Use it for personal scripts and experiments. For production bots, use the official [Messenger Platform](https://developers.facebook.com/docs/messenger-platform).

## What's different from upstream

- **End-to-end encrypted chats.** One-to-one chats are encrypted by default now. `sendMessage` falls back to a built-in E2EE client (Noise handshake + Signal protocol, implemented natively) when a plain send is rejected. Incoming encrypted messages and attachments are decrypted and delivered to `listenMqtt`. `restoreE2EEBackup` restores the encrypted chat history from your recovery code.
- **Current send path.** Text messages go out as LightSpeed tasks over the MQTT connection, like the web client does today.
- **Calls.** `call`, `acceptCall`, `declineCall`, `endCall`, with optional real two-way WebRTC audio from WAV files or PCM callbacks.
- **Groups, feed, posts and comments.** Create groups and posts, read members, events, files and media, moderate join requests, comment and react.
- **Login.** appState, web email/password, and email/password with an authenticator (TOTP) secret through the mobile auth endpoint.
- **Security.** The deprecated `request` and `websocket-stream` packages are gone, replaced by a small in-house HTTP client and `ws` 8. `npm audit` reports 0 vulnerabilities. Credential and key files are written owner-only.

See the [changelog](CHANGELOG.md) for the full list.

## Requirements

- Node.js **22.23.2 or newer**. Older releases carry known security issues.
- Optional, only for real call audio: [`@roamhq/wrtc`](https://www.npmjs.com/package/@roamhq/wrtc) (preferred), or `werift` + `opusscript`. They are listed as optional dependencies, so npm installs them when your platform supports them.

## Install

The package isn't published to npm under this name. Install it from GitHub:

```bash
npm install bhhoang/fbapi-unofficial
```

It still installs as `facebook-chat-api`, so you `require` it by that name:

```js
const login = require("facebook-chat-api");
```

`npm install facebook-chat-api` gets the old upstream release, not this fork.

## Quick start

Save your Facebook cookies to `appstate.json` (see [Logging in](#logging-in)), then:

```js
const fs = require("fs");
const login = require("facebook-chat-api");

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));

login({appState: appState}, (err, api) => {
    if (err) return console.error(err.error || err);

    // Keep the session fresh for the next run.
    fs.writeFileSync("appstate.json", JSON.stringify(api.getAppState(), null, 2));

    // Echo bot. listenMqtt must be running before you send messages.
    api.listenMqtt((err, event) => {
        if (err) return console.error(err);
        if (event.type === "message" && event.body) {
            api.sendMessage("echo: " + event.body, event.threadID);
        }
    });
});
```

## Logging in

**appState (recommended).** An appState is the array of `facebook.com` cookies from a browser where you're already logged in. It skips the password, 2FA and checkpoint steps entirely. Log in to facebook.com, export your cookies as a JSON array with a cookie-export extension, and pass them as `{appState: [...]}`. Cookies in both the `{key, value}` and `{name, value}` shapes are accepted. Save `api.getAppState()` after each login to keep the session current. An expired session shows up as `"Not logged in."`; export a fresh one when that happens.

A ready-to-run version is in [`examples/loginWithAppState.js`](examples/loginWithAppState.js):

```bash
node examples/loginWithAppState.js [path/to/appstate.json]
```

**Email and password.** `login({email, password}, cb)` replays the web login. If Facebook asks for an interactive security check (a CAPTCHA) the login fails with `err.twoFactorRequired === true`, and you'll need to use an appState instead.

**Email, password and authenticator app.** Pass `twoFactorSecret` (the base32 secret shown when you set up the authenticator) and the library logs in through Facebook's mobile auth endpoint and generates the TOTP code itself:

```js
login({email: "FB_EMAIL", password: "FB_PASSWORD", twoFactorSecret: "BASE32_SECRET"}, cb);
```

The mobile device identity is saved to `mobile_device.json` so that a "Was this you?" approval sticks between runs. If Facebook asks you to approve the login, the error has `error: "login-approval"`: approve it from the Facebook app on another device, then log in again.

**appState plus credentials.** Passing both refreshes the session on the same browser device, so Facebook doesn't see it as a new login.

Full details: [`login`](DOCS.md#login).

## Sending messages

```js
api.sendMessage("Hey!", threadID);

api.sendMessage({
    body: "Here's the file",
    attachment: fs.createReadStream(__dirname + "/image.jpg")
}, threadID, (err, info) => {
    if (err) return console.error(err);
    console.log("sent", info.messageID);
});
```

A message has an optional `body`, plus at most one of `sticker` (a sticker ID), `attachment` (a readable stream or an array of them), `url`, or `emoji` with `emojiSize` (`small`, `medium`, `large`). See [`sendMessage`](DOCS.md#sendMessage).

**Encrypted one-to-one chats** need no extra code. The first encrypted send (or an explicit [`api.connectE2EE`](DOCS.md#connectE2EE) at startup) registers this library as an E2EE device on your account and stores its keys in `e2ee_device.json`. **Keep that file:** deleting it registers a new device. Text and attachments are supported; encrypted group chats are not. Download encrypted attachment media with [`downloadE2EEAttachment`](DOCS.md#downloadE2EEAttachment).

```bash
node examples/sendE2EE.js <userID> [path/to/appstate.json]
```

## Calls

```js
api.call(userID, {media: {audioFile: "hello.wav", recordFile: "reply.wav"}}, (err, call) => {
    if (err) return console.error(err);
    // ...later
    api.endCall(call.callID);
});
```

Without `media`, only signaling runs (the call rings, is answered or declined, and ends). Incoming calls arrive as events on `listenMqtt`; call [`api.connectCalls`](DOCS.md#connectCalls) at startup to receive them. See [`call`](DOCS.md#call) for all the audio options, and [`examples/call.js`](examples/call.js) for a signaling-only example.

## Examples

| Script | What it does |
| --- | --- |
| [`examples/loginWithAppState.js`](examples/loginWithAppState.js) | Log in with an appState and keep it refreshed |
| [`examples/sendE2EE.js`](examples/sendE2EE.js) | Send an end-to-end encrypted message |
| [`examples/captureE2EE.js`](examples/captureE2EE.js) | Log raw E2EE frames and print incoming encrypted messages (for debugging the protocol) |
| [`examples/call.js`](examples/call.js) | Place a call and drive its signaling (no audio) |

## Documentation

Every function is documented in [DOCS.md](DOCS.md).

**Session:** [`login`](DOCS.md#login) · [`getAppState`](DOCS.md#getAppState) · [`getCurrentUserID`](DOCS.md#getCurrentUserID) · [`setOptions`](DOCS.md#setOptions) · [`logout`](DOCS.md#logout)

**Messaging:** [`sendMessage`](DOCS.md#sendMessage) · [`listenMqtt`](DOCS.md#listenMqtt) · [`unsendMessage`](DOCS.md#unsendMessage) · [`deleteMessage`](DOCS.md#deleteMessage) · [`forwardAttachment`](DOCS.md#forwardAttachment) · [`setMessageReaction`](DOCS.md#setMessageReaction) · [`sendTypingIndicator`](DOCS.md#sendTypingIndicator) · [`markAsRead`](DOCS.md#markAsRead) · [`markAsReadAll`](DOCS.md#markAsReadAll) · [`markAsDelivered`](DOCS.md#markAsDelivered) · [`searchMessages`](DOCS.md#searchMessages) · [`getEmojiUrl`](DOCS.md#getEmojiUrl) · [`resolvePhotoUrl`](DOCS.md#resolvePhotoUrl)

**Encryption:** [`connectE2EE`](DOCS.md#connectE2EE) · [`downloadE2EEAttachment`](DOCS.md#downloadE2EEAttachment) · [`restoreE2EEBackup`](DOCS.md#restoreE2EEBackup)

**Threads:** [`getThreadList`](DOCS.md#getThreadList) · [`getThreadInfo`](DOCS.md#getThreadInfo) · [`getThreadHistory`](DOCS.md#getThreadHistory) · [`getThreadPictures`](DOCS.md#getThreadPictures) · [`searchForThread`](DOCS.md#searchForThread) · [`createPoll`](DOCS.md#createPoll) · [`setTitle`](DOCS.md#setTitle) · [`changeThreadColor`](DOCS.md#changeThreadColor) · [`threadColors`](DOCS.md#threadColors) · [`changeThreadEmoji`](DOCS.md#changeThreadEmoji) · [`changeNickname`](DOCS.md#changeNickname) · [`changeGroupImage`](DOCS.md#changeGroupImage) · [`addUserToGroup`](DOCS.md#addUserToGroup) · [`removeUserFromGroup`](DOCS.md#removeUserFromGroup) · [`changeAdminStatus`](DOCS.md#changeAdminStatus) · [`changeArchivedStatus`](DOCS.md#changeArchivedStatus) · [`muteThread`](DOCS.md#muteThread) · [`deleteThread`](DOCS.md#deleteThread) · [`handleMessageRequest`](DOCS.md#handleMessageRequest)

**Users:** [`getUserID`](DOCS.md#getUserID) · [`getUserInfo`](DOCS.md#getUserInfo) · [`getFriendsList`](DOCS.md#getFriendsList) · [`changeBlockedStatus`](DOCS.md#changeBlockedStatus)

**Calls:** [`call`](DOCS.md#call) · [`acceptCall`](DOCS.md#acceptCall) · [`declineCall`](DOCS.md#declineCall) · [`endCall`](DOCS.md#endCall) · [`getCalls`](DOCS.md#getCalls) · [`connectCalls`](DOCS.md#connectCalls)

**Groups:** [`createGroup`](DOCS.md#createGroup) · [`updateGroup`](DOCS.md#updateGroup) · [`updateGroupDiscoverability`](DOCS.md#updateGroupDiscoverability) · [`getGroupInfo`](DOCS.md#getGroupInfo) · [`getGroupRules`](DOCS.md#getGroupRules) · [`getGroupMembers`](DOCS.md#getGroupMembers) · [`searchGroupMembers`](DOCS.md#searchGroupMembers) · [`inviteToGroup`](DOCS.md#inviteToGroup) · [`joinGroup`](DOCS.md#joinGroup) · [`leaveGroup`](DOCS.md#leaveGroup) · [`followGroup`](DOCS.md#followGroup) · [`unfollowGroup`](DOCS.md#unfollowGroup) · [`markGroupVisited`](DOCS.md#markGroupVisited) · [`approveJoinRequest`](DOCS.md#approveJoinRequest) · [`declineJoinRequest`](DOCS.md#declineJoinRequest) · [`removeGroupMember`](DOCS.md#removeGroupMember) · [`blockGroupMember`](DOCS.md#blockGroupMember) · [`getGroupEvents`](DOCS.md#getGroupEvents) · [`getGroupFiles`](DOCS.md#getGroupFiles) · [`getGroupMedia`](DOCS.md#getGroupMedia)

**Posts and feed:** [`getFeed`](DOCS.md#getFeed) · [`getGroupPosts`](DOCS.md#getGroupPosts) · [`searchGroupPosts`](DOCS.md#searchGroupPosts) · [`createGroupPost`](DOCS.md#createGroupPost) · [`editGroupPost`](DOCS.md#editGroupPost) · [`deleteGroupPost`](DOCS.md#deleteGroupPost) · [`pinGroupPost`](DOCS.md#pinGroupPost) · [`unpinGroupPost`](DOCS.md#unpinGroupPost) · [`likePost`](DOCS.md#likePost) · [`setPostReaction`](DOCS.md#setPostReaction) · [`getPostReactions`](DOCS.md#getPostReactions) · [`getPostComments`](DOCS.md#getPostComments) · [`createComment`](DOCS.md#createComment) · [`editComment`](DOCS.md#editComment) · [`deleteComment`](DOCS.md#deleteComment) · [`setCommentReaction`](DOCS.md#setCommentReaction)

**Legacy:** [`listen`](DOCS.md#listen) and the `*Deprecated` functions are kept for compatibility. Use `listenMqtt` for new code.

## Files that hold secrets

These files contain session cookies, credentials or private keys. Never commit or share them.

| File | Contents |
| --- | --- |
| `appstate.json` | Your Facebook session cookies. Anyone with it is logged in as you. |
| `e2ee_device.json` | The private keys of this library's E2EE device |
| `mobile_device.json` | The mobile login device identity |
| `test/test-config.json`, `test/test-appstate.json` | Test account credentials |

All but `appstate.json` are already in `.gitignore`. Add it (or wherever you keep your appState) to your own project's `.gitignore`.

## Development

```bash
npm run test:unit   # offline tests for the HTTP and WebSocket layers
npm test            # live integration tests against a real account
npm run lint
```

The live tests need `test/test-config.json`: copy `test/example-config.json`, remove the comments and fill it in (or set the `testconfig` environment variable to that JSON). Use a throwaway account; [Facebook whitehat test accounts](https://www.facebook.com/whitehat/accounts/) work well.

The code style is deliberately old-school CommonJS with callbacks and `bluebird` promises. New API functions go in `src/<name>.js` and must be registered in `apiFuncNames` in `index.js`, then documented in `DOCS.md`, this README and `CHANGELOG.md`.

## FAQ

**Sending fails with `forceWebClientRefresh`.**
Facebook bumped the web client version. `LS_VERSION_ID` in `src/sendMessage.js` needs updating from the current web bundle.

**A groups or feed function suddenly returns nothing.**
Facebook rotated the persisted query. The `DOC_ID` in that function's `src/` file is stale, or a new `__relay_internal__pv__*` variable became required.

**Can I send as a page?**
Yes. Pass `pageID` in the login options: `login(credentials, {pageID: "000000000000000"}, cb)`. It has to be set at login; `setOptions` can't change it later. Pages can't start conversations with users.

**How do I silence the logs?**
`api.setOptions({logLevel: "silent"})`.

**Where do I find my user ID?**
It's the value of the `c_user` cookie, or call `api.getCurrentUserID()`.

## Credits and license

Built on [facebook-chat-api](https://github.com/Schmavery/facebook-chat-api) by Avery, Benjamin, David, Maude and its many contributors. MIT licensed; see [LICENSE-MIT](LICENSE-MIT).

This project isn't affiliated with, endorsed by or supported by Meta or Facebook.
