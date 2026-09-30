# Documentation

* [`login`](#login)
* [`api.acceptCall`](#acceptCall)
* [`api.addUserToGroup`](#addUserToGroup)
* [`api.approveJoinRequest`](#approveJoinRequest)
* [`api.blockGroupMember`](#blockGroupMember)
* [`api.call`](#call)
* [`api.changeAdminStatus`](#changeAdminStatus)
* [`api.changeArchivedStatus`](#changeArchivedStatus)
* [`api.changeBlockedStatus`](#changeBlockedStatus)
* [`api.changeGroupImage`](#changeGroupImage)
* [`api.changeNickname`](#changeNickname)
* [`api.changeThreadColor`](#changeThreadColor)
* [`api.changeThreadEmoji`](#changeThreadEmoji)
* [`api.connectCalls`](#connectCalls)
* [`api.connectE2EE`](#connectE2EE)
* [`api.createComment`](#createComment)
* [`api.createGroup`](#createGroup)
* [`api.createGroupPost`](#createGroupPost)
* [`api.createPoll`](#createPoll)
* [`api.declineCall`](#declineCall)
* [`api.declineJoinRequest`](#declineJoinRequest)
* [`api.deleteComment`](#deleteComment)
* [`api.deleteGroupPost`](#deleteGroupPost)
* [`api.deleteMessage`](#deleteMessage)
* [`api.deleteThread`](#deleteThread)
* [`api.downloadE2EEAttachment`](#downloadE2EEAttachment)
* [`api.editComment`](#editComment)
* [`api.editGroupPost`](#editGroupPost)
* [`api.endCall`](#endCall)
* [`api.followGroup`](#followGroup)
* [`api.forwardAttachment`](#forwardAttachment)
* [`api.getAppState`](#getAppState)
* [`api.getCalls`](#getCalls)
* [`api.getCurrentUserID`](#getCurrentUserID)
* [`api.getEmojiUrl`](#getEmojiUrl)
* [`api.getFeed`](#getFeed)
* [`api.getFriendsList`](#getFriendsList)
* [`api.getGroupEvents`](#getGroupEvents)
* [`api.getGroupFiles`](#getGroupFiles)
* [`api.getGroupInfo`](#getGroupInfo)
* [`api.getGroupMedia`](#getGroupMedia)
* [`api.getGroupMembers`](#getGroupMembers)
* [`api.getGroupPosts`](#getGroupPosts)
* [`api.getGroupRules`](#getGroupRules)
* [`api.getPostComments`](#getPostComments)
* [`api.getPostReactions`](#getPostReactions)
* [`api.getThreadHistory`](#getThreadHistory)
* [`api.getThreadInfo`](#getThreadInfo)
* [`api.getThreadList`](#getThreadList)
* [`api.getThreadPictures`](#getThreadPictures)
* [`api.getUserID`](#getUserID)
* [`api.getUserInfo`](#getUserInfo)
* [`api.handleMessageRequest`](#handleMessageRequest)
* [`api.inviteToGroup`](#inviteToGroup)
* [`api.joinGroup`](#joinGroup)
* [`api.leaveGroup`](#leaveGroup)
* [`api.likePost`](#likePost)
* [`api.listen`](#listen)
* [`api.listenMqtt`](#listenMqtt)
* [`api.logout`](#logout)
* [`api.markAsDelivered`](#markAsDelivered)
* [`api.markAsRead`](#markAsRead)
* [`api.markAsReadAll`](#markAsReadAll)
* [`api.markAsUnread`](#markAsUnread)
* [`api.markGroupVisited`](#markGroupVisited)
* [`api.muteThread`](#muteThread)
* [`api.pinGroupPost`](#pinGroupPost)
* [`api.removeGroupMember`](#removeGroupMember)
* [`api.removeUserFromGroup`](#removeUserFromGroup)
* [`api.resolvePhotoUrl`](#resolvePhotoUrl)
* [`api.restoreE2EEBackup`](#restoreE2EEBackup)
* [`api.searchForThread`](#searchForThread)
* [`api.searchGroupMembers`](#searchGroupMembers)
* [`api.searchMessages`](#searchMessages)
* [`api.searchGroupPosts`](#searchGroupPosts)
* [`api.sendMessage`](#sendMessage)
* [`api.sendTypingIndicator`](#sendTypingIndicator)
* [`api.setCommentReaction`](#setCommentReaction)
* [`api.setMessageReaction`](#setMessageReaction)
* [`api.setOptions`](#setOptions)
* [`api.setPostReaction`](#setPostReaction)
* [`api.setTitle`](#setTitle)
* [`api.threadColors`](#threadColors)
* [`api.unfollowGroup`](#unfollowGroup)
* [`api.unpinGroupPost`](#unpinGroupPost)
* [`api.unsendMessage`](#unsendMessage)
* [`api.updateGroup`](#updateGroup)
* [`api.updateGroupDiscoverability`](#updateGroupDiscoverability)

---------------------------------------

### Password safety

**Read this** before you _copy+paste_ examples from below.

You should not store Facebook password in your scripts.
There are few good reasons:
* People who are standing behind you may look at your "code" and get your password if it is on the screen
* Backups of source files may be readable by someone else. "_There is nothing secret in my code, why should I ever password protect my backups_"
* You can't push your code to Github (or any onther service) without removing your password from the file.  Remember: Even if you undo your accidential commit with password, Git doesn't delete it, that commit is just not used but is still readable by everybody.
* If you change your password in the future (maybe it leaked because _someone_ stored password in source file… oh… well…) you will have to change every occurrence in your scripts

Preferred method is to have `login.js` that saves `AppState` to a file and then use that file from all your scripts.
This way you can put password in your code for a minute, login to facebook and then remove it.

If you want to be even more safe:  _login.js_ can get password with `require("readline")` or with environment variables like this:
```js
var credentials = {
    email: process.env.FB_EMAIL,
    password: process.env.FB_PASSWORD
}
```
```bash
FB_EMAIL="john.doe@example.com"
FB_PASSWORD="MySuperHardP@ssw0rd"
nodejs login.js
```

---------------------------------------

<a name="login"></a>
### login(credentials[, options], callback)

This function is returned by `require(...)` and is the main entry point to the API.

It allows the user to log into facebook given the right credentials.

If it succeeds, `callback` will be called with a `null` object (for potential errors) and with an object containing all the available functions.

If it fails, `callback` will be called with an error object.

__Arguments__

* `credentials`: An object with the fields `email` and `password` used to login (the `email` field also accepts a phone number or the numeric user ID), __*or*__ an object containing the field `appState`. For accounts with an authenticator app (TOTP) you can also pass `twoFactorSecret` — the base32 secret shown when 2FA was set up — and the library will generate the code itself.
* `options`: An object representing options to use when logging in (as described in [api.setOptions](#setOptions)).
* `callback(err, api)`: A callback called when login is done (successful or not). `err` is an object containing a field `error`.

> **Note:** When a `twoFactorSecret` is provided (or `mobileLogin: true` is
> set), the login goes through Facebook's mobile app auth endpoint instead of
> the web form. That endpoint reports the two-factor challenge explicitly and
> accepts the generated TOTP code, so it can complete a 2FA login
> programmatically — no web CAPTCHA involved. Without a `twoFactorSecret` the
> web form is used; if Facebook then wants an interactive security check
> (Arkose CAPTCHA) before accepting the code, the login fails with
> `err.twoFactorRequired === true`. Pass `mobileLogin: false` to always use the
> web form. `appState` remains the recommended approach for unattended scripts.
>
> The mobile login uses a persisted device identity (default
> `./mobile_device.json`, configurable with `api.setOptions({ mobileDevicePath })`)
> because Facebook binds two-factor challenges and "Someone is trying to log in /
> Approve this login" prompts to a device. If Facebook asks for approval, approve
> the prompt from the Facebook app on another signed-in device and run the login
> again — the same device identity is reused, so the approval applies. Avoid
> making many attempts in a row: Facebook temporarily answers with a generic
> "Wrong username/password" while it rate-limits repeated failures.

__Example (Email & Password with TOTP 2FA)__

```js
const login = require("facebook-chat-api");

login({
    email: "FB_EMAIL",
    password: "FB_PASSWORD",
    twoFactorSecret: "BASE32_TOTP_SECRET", // authenticator app secret
    mobileLogin: true                      // optional; implied by twoFactorSecret
}, (err, api) => {
    if(err) return console.error(err);
    // Here you can use the api
});
```

__Example (Email & Password)__

```js
const login = require("facebook-chat-api");

login({email: "FB_EMAIL", password: "FB_PASSWORD"}, (err, api) => {
    if(err) return console.error(err);
    // Here you can use the api
});
```

__Example (Email & Password then save appState to file)__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({email: "FB_EMAIL", password: "FB_PASSWORD"}, (err, api) => {
    if(err) return console.error(err);

    fs.writeFileSync('appstate.json', JSON.stringify(api.getAppState()));
});
```

__Example (AppState loaded from file)__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);
    // Here you can use the api
});
```

__Example (Refresh a session with email & password)__

Pass the `appState` **together with** `email`/`password` to re-authenticate on the
same browser device. The device cookies (`datr`, `sb`, ...) from the appState
are reused, so Facebook sees a recognized browser instead of a brand-new device
— no "unrecognized device" lock and normally no two-factor challenge. This is
the way to keep a long-running bot's session fresh from stored credentials, and
it also refreshes the appState:

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({
    appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8')),
    email: "FB_EMAIL",
    password: "FB_PASSWORD",
    twoFactorSecret: "BASE32_TOTP_SECRET" // used only if Facebook asks for a code
}, (err, api) => {
    if(err) return console.error(err);

    // Save the refreshed session for next time.
    fs.writeFileSync('appstate.json', JSON.stringify(api.getAppState(), null, 2));
});
```

__Login Approvals (2-Factor Auth)__: When you try to login with Login Approvals enabled, your callback will be called with an error `'login-approval'` that has a `continue` function that accepts the approval code as a `string` or a `number`. If you passed `twoFactorSecret` in the credentials, the library generates and submits the TOTP code itself instead.

__Example__:

```js
const fs = require("fs");
const login = require("facebook-chat-api");
const readline = require("readline");

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const obj = {email: "FB_EMAIL", password: "FB_PASSWORD"};
login(obj, (err, api) => {
    if(err) {
        switch (err.error) {
            case 'login-approval':
                console.log('Enter code > ');
                rl.on('line', (line) => {
                    err.continue(line);
                    rl.close();
                });
                break;
            default:
                console.error(err);
        }
        return;
    }

    // Logged in!
});
```

__Review Recent Login__: Sometimes Facebook will ask you to review your recent logins. This means you've recently logged in from a unrecognized location. This will will result in the callback being called with an error `'review-recent-login'` by default. If you wish to automatically approve all recent logins, you can set the option `forceLogin` to `true` in the `loginOptions`.


---------------------------------------

<a name="addUserToGroup"></a>
### api.addUserToGroup(userID, threadID[, callback])

Adds a user (or array of users) to a group chat.

__Arguments__

* `userID`: User ID or array of user IDs.
* `threadID`: Group chat ID.
* `callback(err)`: A callback called when the query is done (either with an error or with no arguments).

---------------------------------------

<a name="approveJoinRequest"></a>
### api.approveJoinRequest(groupID, userID[, callback])

Approves a pending request to join a Facebook Group (requires admin/moderator rights). The user must have a pending request — you can see pending users with [`api.getGroupInfo`](#getGroupInfo) on their account, or in the group's Member requests page.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `userID`: The ID of the user whose request to approve.
* `callback(err, result)`: Called with `{groupID, userID, approved: true}`.

---------------------------------------

<a name="blockGroupMember"></a>
### api.blockGroupMember(groupID, userID[, callback])

Bans (blocks) a member from a Facebook Group — the "Ban from group" action in the member menu. Requires admin/moderator rights. Facebook refuses to ban the last admin.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `userID`: The ID of the member to ban.
* `callback(err, result)`: Called with `{groupID, userID, blocked: true}`.

---------------------------------------

<a name="call"></a>
### api.call(threadID[, options], callback)

Places a voice (or video) call through Messenger's call signaling. `threadID` is the user ID to call, or the group thread ID when `options.groupThreadID` is set.

Signaling is sent on the same MQTT connection used by [`api.listenMqtt`](#listenMqtt); an internal connection is opened automatically the first time a call function is used. `api.listenMqtt` does not have to be running, but it is the only way to receive [call events](#call-events).

__Signaling-only by default__: without the `media` option no audio is transmitted — a synthesized SDP offer is sent so the called device rings, shows the call and can answer or decline.

__Real audio (`options.media`)__: pass `media: true` to negotiate a real WebRTC audio connection. Audio comes from a 16-bit PCM WAV file and/or goes to a WAV recording — Node has no microphone, so both are file/callback based. Two media engines are supported:

* **`@roamhq/wrtc`** (`npm install @roamhq/wrtc`, the full libwebrtc stack) — preferred when installed: Opus is built in, and it supports ICE-TCP and TURN relays over TCP/TLS, which the restricted networks need. This is the engine that was verified working against Facebook's conference. It has no video pipeline.
* **`werift`** (`npm install werift`, pure JavaScript) + optional [`opusscript`](https://www.npmjs.com/package/opusscript) for Opus — a lighter fallback that also carries the video pipeline. **Video calls (one-to-one or group) automatically use this engine**, since the libwebrtc binding cannot send or receive video.

Facebook's call relays (TURN) are fetched automatically (`/videocall/turndiscovery/`) before the media is created, and the client subscribes to the conference's dominant-speaker stream and answers the SFU's renegotiation offers, so audio is both sent and received:

```js
api.call(userID, {
  media: {
    audioFile: "tts.wav",     // streamed to the call in a loop (8/16/44.1 kHz PCM WAV)
    recordFile: "call.wav",   // written when the call ends
    onAudioData: function(pcm8k) {}, // optional live incoming PCM
    engine: "wrtc",           // "wrtc" (default when installed) or "werift" (automatic for video calls)
    codec: "opus",            // werift engine: "opus" (default when available) or "pcmu"
    autoStart: false,         // true = start the file as soon as the media is up
    audioDelayMs: 500,        // wait this long after the peer joins
    iceServers: [],           // extra STUN/TURN servers (Facebook's relays are applied automatically)
    iceInterfaceAddresses: [],// pin ICE to specific local interfaces on multi-homed machines
    turnTransport: "tcp",     // prefer the relay over TCP/TLS (restrictive networks)
    opusBitrate: 128000       // Opus target bitrate in bps (default 128000, max 510000)
  }
}, callback);
```

The audio file (and `videoFile`, which starts with it) is held until the other side is actually in the call (their participant state reaches `CONNECTED`; a 1:1 call falls back to 10 s after it is answered if that state never arrives) and then starts after `audioDelayMs` (default 0.5 s), so the beginning of the file is not played to an empty conference. `autoStart: true` restores the immediate start.

> Media uses the network the same way the web client does: **direct UDP (STUN), ICE-TCP, and Facebook's TURN relays (UDP, plain TCP, TLS)**. On networks that block outbound UDP to Facebook (some VPNs, locked-down corporate links) the client falls back to the TCP transports — the `werift` engine carries DTLS/SRTP over ICE-TCP and TURN-TCP, which has been verified against the conference edge. Set `turnTransport: "tcp"` to prefer the relay over TCP when the direct paths are blocked.

__E2EE (secure) calls__: one-to-one Messenger chats are end-to-end encrypted, so calls placed on them are E2EE mandated. Facebook requires the client's E2EE call state (the `E2eeState` state-sync topic) when joining; this library builds it from its own E2EE device (registering one automatically if needed), and signs the DTLS handshake with the account's identity key (`a=x-dtls-auth`, generated with Meta's frame-encryption wasm, downloaded and cached on first use). Group calls are not E2EE mandated.

Real media for **one-to-one E2EE** calls works as well: the clients trade `E2eeKey` data messages, derive the SFrame keys from them, and every audio frame is encrypted before it leaves the socket and decrypted on arrival (Meta's frame-encryption wasm runs in a helper process). The library subscribes to the peer's track in the conference, answers the SFU's renegotiation offers, and carries the media over ICE-TCP/TURN-TCP when UDP is blocked. Scope: one-to-one voice.

**Group calls** join Facebook's SFU (`ROOM` conference) and, with `video: true`, stream video to every member too — the werift engine is selected automatically because the libwebrtc binding is audio-only. Video viewing from your side arrives once you join and the SFU forwards it. Group calls are not E2EE-mandated (Meta's group call key agreement is not implemented), same as the browser's group calls being secured by the SFU rather than end-to-end.

__Arguments__

* `threadID`: The ID of the user (or group thread) to call.
* `options`: Optional object.
  * `video`: `true` to request a video call (default is audio).
  * `e2ee`: Set to `false` for a non-E2EE call (default: `true` for one-to-one calls, `false` for group calls).
  * `e2eeState`: Buffer with the E2EE call state. Built automatically from the library's E2EE device when omitted.
  * `syncPayload`: Full state-sync payload to send instead of the built-in one.
  * `media`: `true`, or an object (`audioFile`, `recordFile`, `onAudioData`, `engine`, `codec`, `opusBitrate`, `iceServers`) for real WebRTC audio. Requires one of the optional media engines. See above.
  * `offerSdp`: SDP offer to send (default: a synthesized audio/video offer).
  * `groupThreadID`: Call a group thread, ringing the users in `invitees`.
  * `invitees`: For group calls, the user IDs to ring (default: `[threadID]`).
  * `mediaMode`: `1` (SFU, default for groups and one-to-one video calls) or `2` (P2P, default for one-to-one voice calls). One-to-one video calls join the SFU directly: started P2P, a Messenger web callee showed the caller's avatar instead of the video.
  * `callTrigger`: Value for the `call_trigger` joining-context field.
  * `timeout`: Milliseconds to wait for Facebook to accept the call (default `20000`).
* `callback(err, call)`: Called when the call is ringing (or failed). `call` contains `callID` (the thread ID), `state`, `conferenceName`, etc.

__Example__

```js
api.call(userID, { video: false }, function(err, call) {
  if (err) return console.error(err.error);
  console.log("ringing", call.callID);
  // hang up after 10 seconds
  setTimeout(function() { api.endCall(call.callID); }, 10000);
});
```

---------------------------------------

<a name="acceptCall"></a>
### api.acceptCall([callID][, options], callback)

Accepts a ringing incoming call. Send the ringing event through [`api.listenMqtt`](#call-events) to learn the `callID`. If only one call is active, `callID` can be omitted.

__Arguments__

* `callID`: Optional `callID`/`threadID` of the incoming call.
* `options`: Optional object with the same `e2ee`, `e2eeState`, `syncPayload`, `offerSdp` and `answerSdp` fields as [`api.call`](#call). When the incoming call is E2EE mandated, the E2EE state is required.
* `callback(err, call)`: Called when the join is sent (or with an error).

---------------------------------------

<a name="declineCall"></a>
### api.declineCall([callID][, callback])

Declines a ringing incoming call (hangup with reason `IGNORE_CALL`). `callID` can be omitted when only one call is active.

* `callback(err, call)`: Called when the hangup is sent (or with an error).

---------------------------------------

<a name="endCall"></a>
### api.endCall([callID][, callback])

Ends an active call, or cancels a call that is still ringing (hangup with reason `HANGUP_CALL`). `callID` can be omitted when only one call is active.

* `callback(err, call)`: Called when the hangup is sent (or with an error).

---------------------------------------

<a name="getCalls"></a>
### api.getCalls([callback])

Returns an array describing the calls this client currently knows about (ringing, incoming or connected): `callID`, `threadID`, `peerID`, `callerID`, `direction` (`"outgoing"`/`"incoming"`), `state` (`"starting"`, `"ringing"`, `"incoming"`, `"joining"`, `"connected"`), `isGroup`, `isVideo`, `conferenceName`, `mediaPath` and `startedAt`.

### Call events

While [`api.listenMqtt`](#listenMqtt) is running, call signaling is reported through the same callback:

* `{type: "call", event: "ring", callID, peerID, isVideo, isGroup}`: an incoming call is ringing. Answer with [`api.acceptCall`](#acceptCall) or [`api.declineCall`](#declineCall).
* `{type: "call", event: "calling"}`: an outgoing call was accepted by Facebook and the peer is ringing.
* `{type: "call", event: "connected"}`: the peer answered.
* `{type: "call", event: "ended", reason}`: the call ended (for example `HANGUP_CALL`, `IGNORE_CALL`, `NO_ANSWER_TIMEOUT` or a `DismissReason`).

```js
api.listenMqtt(function(err, event) {
  if (!event || event.type !== "call") return;
  if (event.event === "ring") {
    console.log("incoming call from", event.peerID);
    // api.acceptCall(event.callID); // or api.declineCall(event.callID);
  }
});
```

---------------------------------------

<a name="changeAdminStatus"></a>
### api.changeAdminStatus(threadID, adminIDs, adminStatus[, callback])

Given a adminID, or an array of adminIDs, will set the admin status of the user(s) to `adminStatus`.

__Arguments__
* `threadID`: ID of a group chat (can't use in one-to-one conversations)
* `adminIDs`: The id(s) of users you wish to admin/unadmin (string or an array).
* `adminStatus`: Boolean indicating whether the user(s) should be promoted to admin (`true`) or demoted to a regular user (`false`).
* `callback(err)`: A callback called when the query is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if (err) return console.error(err);

    let threadID = "0000000000000000";
    let newAdmins = ["111111111111111", "222222222222222"];
    api.changeAdminStatus(threadID, newAdmins, true, editAdminsCallback);

    let adminToRemove = "333333333333333";
    api.changeAdminStatus(threadID, adminToRemove, false, editAdminsCallback);

});

function editAdminsCallback(err) {
    if (err) return console.error(err);
}

```

---------------------------------------

<a name="changeArchivedStatus"></a>
### api.changeArchivedStatus(threadOrThreads, archive[, callback])

Given a threadID, or an array of threadIDs, will set the archive status of the threads to `archive`. Archiving a thread will hide it from the logged-in user's inbox until the next time a message is sent or received.

__Arguments__
* `threadOrThreads`: The id(s) of the threads you wish to archive/unarchive.
* `archive`: Boolean indicating the new archive status to assign to the thread(s).
* `callback(err)`: A callback called when the query is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.changeArchivedStatus("000000000000000", true, (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="changeBlockedStatus"></a>
### api.changeBlockedStatus(userID, block[, callback])

Prevents a user from privately contacting you. (Messages in a group chat will still be seen by both parties).

__Arguments__

* `userID`: User ID.
* `block`: Boolean indicating whether to block or unblock the user (true for block).
* `callback(err)`: A callback called when the query is done (either with an error or with no arguments).

---------------------------------------

<a name="changeGroupImage"></a>
### api.changeGroupImage(image, threadID[, callback])

Will change the group chat's image to the given image.

__Arguments__
* `image`: File stream of image.
* `threadID`: String representing the ID of the thread.
* `callback(err)`: A callback called when the change is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.changeGroupImage(fs.createReadStream("./avatar.png"), "000000000000000", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="changeNickname"></a>
### api.changeNickname(nickname, threadID, participantID[, callback])

Will change the thread user nickname to the one provided.

__Arguments__
* `nickname`: String containing a nickname. Leave empty to reset nickname.
* `threadID`: String representing the ID of the thread.
* `participantID`: String representing the ID of the user.
* `callback(err)`: An optional callback called when the change is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.changeNickname("Example", "000000000000000", "000000000000000", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="changeThreadColor"></a>
### api.changeThreadColor(color, threadID[, callback])

Will change the thread color to the given hex string color ("#0000ff"). Set it
to empty string if you want the default.

Note: the color needs to start with a "#".

__Arguments__
* `color`: String representing a hex color code (eg: "#0000ff") preceded by "#".
* `threadID`: String representing the ID of the thread.
* `callback(err)`: A callback called when the change is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.changeThreadColor("#0000ff", "000000000000000", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="changeThreadEmoji"></a>
### api.changeThreadEmoji(emoji, threadID[, callback])

Will change the thread emoji to the one provided.

Note: The UI doesn't play nice with all emoji.

__Arguments__
* `emoji`: String containing a single emoji character.
* `threadID`: String representing the ID of the thread.
* `callback(err)`: A callback called when the change is done (either with an error or null).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.changeThreadEmoji("💯", "000000000000000", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="connectCalls"></a>
### api.connectCalls([callback])

Opens the call-signaling connection and subscribes to Messenger's call topic. The call functions ([`api.call`](#call), [`api.acceptCall`](#acceptCall), ...) connect lazily, but an incoming call can only be reported while this connection (and [`api.listenMqtt`](#listenMqtt)) are running — call `api.connectCalls()` at startup to wait for calls.

* `callback(err)`: Optional callback called when the signaling connection is ready (or failed).

<a name="connectE2EE"></a>
### api.connectE2EE([callback])

Connects the built-in end-to-end encryption client. This is normally done automatically by [`api.sendMessage`](#sendMessage) the first time it sends to an encrypted one-to-one chat; calling it explicitly just connects ahead of time, so the first encrypted message doesn't wait for the connection (about 0.3–0.8 s). Calling it right after [`api.listenMqtt`](#listenMqtt) lets both connect at the same time.

`connectE2EE` fetches a Crypto Auth Token, registers this library as an E2EE device for the logged-in account the first time it runs (stored in the device file, see `e2eeDevicePath` in [api.setOptions](#setOptions)), opens the encrypted Noise/WebSocket connection Messenger's E2EE clients use, and uploads one-time prekeys. It is idempotent: calling it again while connected is a no-op.

__Arguments__

* `callback(err, info)`: (Optional) A callback called when the connection is ready (or failed). `info` contains `userId` and the numeric E2EE `deviceId` assigned to this library.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.connectE2EE((err, info) => {
        if(err) return console.error(err);
        console.log("E2EE connected as device " + info.deviceId);
    });
});
```

---------------------------------------

<a name="searchMessages"></a>
### api.searchMessages(threadID, query[, options], callback)

Searches messages of a single chat by paging through [`api.getThreadHistory`](#getThreadHistory), so it works both for regular chats (GraphQL history) and for end-to-end encrypted chats whose backup has been restored (see [`api.restoreE2EEBackup`](#restoreE2EEBackup)). Matching is a case-insensitive substring test on the message body (or the event snippet for events).

__Arguments__

* `threadID`: The thread to search in (user id for one-to-one chats, thread id for groups).
* `query`: The string to look for.
* `options`: Optional object:
  * `amount`: Maximum number of messages to scan (default 300).
  * `pageSize`: How many messages to fetch per page (default 50, max 500).
  * `limit`: Maximum number of matches to return (default 50).
  * `caseSensitive`: Set to `true` for a case-sensitive search (default `false`).
  * `before`: Only search messages older than this timestamp (milliseconds).
* `callback(err, matches)`: Called with an array of matching history entries, newest first (same shape as `getThreadHistory`).

__Example__

```js
api.searchMessages("100035400259877", "meeting", {amount: 500}, (err, matches) => {
    if(err) return console.error(err);
    matches.forEach(m => console.log(m.senderID + ": " + m.body));
});
```

---------------------------------------

<a name="restoreE2EEBackup"></a>
### api.restoreE2EEBackup(options[, callback])

Restores the account's encrypted backup ("Secure Storage") so end-to-end encrypted chat history can be read by [`api.getThreadHistory`](#getThreadHistory). Everything runs natively: the 40-character recovery code derives the virtual device keys, the encrypted secrets are fetched and decrypted, the epoch keys are derived with Meta's Labyrinth WASI module (downloaded and cached on first use, needs Node.js 18+), and the resulting state (device id, mailbox tokens, epoch keys) is stored in the E2EE device file. After a successful restore, `getThreadHistory` returns real backup messages for one-to-one encrypted chats.

__Arguments__

* `options`: Object:
  * `recoveryCode`: The account's 40-character recovery code (the one shown when Secure Storage was set up).
  * `virtualDeviceInfo`: (Optional, advanced) A previously fetched `fetch_virtual_device_info_for_device_addition_v2` payload, to skip the server fetch.
  * `deviceId`: (Optional) Server device entity id to read through; discovered from the backup's device list when omitted.
  * `mailboxRootKey`, `ocmfClientState`, `epochs`: (Optional, advanced) Overrides for the derived values.
  * `wasmPath`: (Optional) Cache path for the `Labyrinth_REPL` wasm module (default: a file in the system temp directory).
* `callback(err, info)`: Called with `{backupId, deviceId, epochs}` when the backup state has been saved.

__Example__

```js
api.restoreE2EEBackup({recoveryCode: "20UX M63K MFAX R0HZ R7AU CSMJ FRTZ 7ZLV ZYPX HAFY"}, (err, info) => {
    if(err) return console.error(err);
    console.log("backup restored, " + info.epochs + " epoch key(s)");

    api.getThreadHistory(someUserID, 20, null, (err, history) => {
        if(err) return console.error(err);
        history.forEach(m => console.log(m.senderID + ": " + m.body));
    });
});
```

---------------------------------------

<a name="createComment"></a>
### api.createComment(postID, message[, options], callback)

Comments on a Facebook post (a post in a Facebook Group or in the feed, not a Messenger message; see [`api.sendMessage`](#sendMessage) for chats). Uses Facebook's internal GraphQL API, which is not part of the official platform — the operation ID behind it can change when Facebook ships a new frontend.

__Arguments__

* `postID`: The ID of the post to comment on (as returned in `postID` by [`api.getGroupPosts`](#getGroupPosts) / [`api.getFeed`](#getFeed)).
* `message`: String with the comment body (or an object with a `body` field).
* `options`: Optional object. Set `replyToCommentID` to the numeric ID of a comment to post the message as a reply to that comment.
* `callback(err, comment)`: Called with the created comment, `{commentID, postID, body}`. `commentID` is Facebook's numeric comment (feedback) ID.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.createComment("1608281820936422", "Nice one!", (err, comment) => {
        if(err) return console.error(err);
        console.log("commented:", comment.commentID);

        // Reply to that comment:
        api.createComment("1608281820936422", "Thanks!", {replyToCommentID: comment.commentID}, (err2) => {
            if(err2) return console.error(err2);
        });
    });
});
```

---------------------------------------

<a name="createGroup"></a>
### api.createGroup(name[, options][, callback])

Creates a new Facebook Group (not a Messenger group chat) owned by the logged-in account.

__Arguments__

* `name`: String with the group name.
* `options`: Optional object:
  * `privacy`: `"PRIVATE"` (default) or `"PUBLIC"`.
  * `discoverability`: `"ANYONE"` (default) or `"MEMBERS_ONLY"`.
  * `members`: Array of user IDs to add as initial members (optional).
* `callback(err, group)`: Called with the created group, `{groupID, name, url, privacy, discoverability}`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.createGroup("My test group", {privacy: "PRIVATE", discoverability: "MEMBERS_ONLY"}, (err, group) => {
        if(err) return console.error(err);
        console.log("created group:", group.groupID);
    });
});
```

---------------------------------------

<a name="createGroupPost"></a>
### api.createGroupPost(groupID, message[, callback])

Creates a text post in a Facebook Group the logged-in account belongs to.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `message`: String with the post body (or an object with a `body` field).
* `callback(err, post)`: Called with the created post, `{postID, groupID, body, url}`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.createGroupPost("1608281640936440", "Hello group!", (err, post) => {
        if(err) return console.error(err);
        console.log("posted:", post.url);
    });
});
```

---------------------------------------

<a name="createPoll"></a>
### api.createPoll(title, threadID[, options][, callback])

Creates a poll with the specified title and optional poll options, which can also be initially selected by the logged-in user.

__Arguments__
* `title`: String containing a title for the poll.
* `threadID`: String representing the ID of the thread.
* `options`: An optional `string : bool` dictionary to specify initial poll options and their initial states (selected/not selected), respectively.
* `callback(err)`: An optional callback called when the poll is posted (either with an error or null) - can omit the `options` parameter and use this as the third parameter if desired.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.createPoll("Example Poll", "000000000000000", {
        "Option 1": false,
        "Option 2": true
    }, (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="declineJoinRequest"></a>
### api.declineJoinRequest(groupID, userID[, callback])

Declines a pending request to join a Facebook Group (requires admin/moderator rights).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `userID`: The ID of the user whose request to decline.
* `callback(err, result)`: Called with `{groupID, userID, declined: true}`.

---------------------------------------

<a name="deleteComment"></a>
### api.deleteComment(postID, commentID[, callback])

Deletes a comment the logged-in account wrote on a Facebook post.

__Arguments__

* `postID`: The ID of the post the comment is on.
* `commentID`: The numeric comment ID (as returned by [`api.createComment`](#createComment)).
* `callback(err, result)`: Called with `{postID, commentID, deleted}`.

__Example__

```js
api.deleteComment("1608281820936422", "1608303754267562", (err) => {
    if(err) return console.error(err);
});
```

---------------------------------------

<a name="deleteGroupPost"></a>
### api.deleteGroupPost(postID[, options][, callback])

Deletes a post (requires that the logged-in account is allowed to delete it — its author, or a group admin).

__Arguments__

* `postID`: The ID of the post.
* `options`: Optional; `authorID` is the post author's user ID (defaults to the logged-in account). Facebook's `story_id` token embeds the author, so posts by other people need it (available as `senderID` from [`api.getGroupPosts`](#getGroupPosts)).
* `callback(err, result)`: Called with `{postID, deleted: true}`.

---------------------------------------

<a name="deleteMessage"></a>
### api.deleteMessage(messageOrMessages[, callback])

Takes a messageID or an array of messageIDs and deletes the corresponding message.

__Arguments__
* `messageOrMessages`: A messageID string or messageID string array
* `callback(err)`: A callback called when the query is done (either with an error or null).

__Example__
```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        if(message.body) {
            api.sendMessage(message.body, message.threadID, (err, messageInfo) => {
                if(err) return console.error(err);

                api.deleteMessage(messageInfo.messageID);
            });
        }
    });
});
```

---------------------------------------

<a name="deleteThread"></a>
### api.deleteThread(threadOrThreads[, callback])

Given a threadID, or an array of threadIDs, will delete the threads from your account. Note that this does *not* remove the messages from Facebook's servers - anyone who hasn't deleted the thread can still view all of the messages.

__Arguments__

* `threadOrThreads` - The id(s) of the threads you wish to remove from your account.
* `callback(err)` - A callback called when the operation is done, maybe with an object representing an error.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.deleteThread("000000000000000", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="downloadE2EEAttachment"></a>
### api.downloadE2EEAttachment(attachment[, callback])

Downloads, decrypts and returns the media of an attachment received on an end-to-end encrypted one-to-one chat.

Messages delivered by `api.listen`/`api.listenMqtt` from the built-in E2EE client carry an `attachments` array. Those media are encrypted with a per-file key that is only present in the message, so they cannot be fetched with a URL: pass one `attachments` entry (the one with an `e2ee` field) to this method to get the plaintext bytes. The media itself is hosted by Facebook's encrypted media service and downloaded over the same E2EE client connection, so the E2EE client must be able to connect (it is created/connected on demand, same as for [`api.sendMessage`](#sendMessage)). The returned `attachment.type` is one of `photo`, `video`, `audio`, `sticker` or `file`.

Group E2EE messages and attachments are not decrypted by this library, so this method only works for the one-to-one attachments that were actually delivered.

__Arguments__

* `attachment`: One entry from a message's `attachments` array (the one with the `e2ee` field).
* `callback(err, buffer)`: Called with the decrypted media as a `Buffer`, or an error.

__Example__

```js
api.listenMqtt((err, message) => {
    if (err) return console.error(err);
    if (!message.attachments || !message.attachments.length) return;

    var attachment = message.attachments[0];
    api.downloadE2EEAttachment(attachment, (err, buffer) => {
        if (err) return console.error(err);
        var fs = require("fs");
        var name = attachment.filename || "attachment";
        fs.writeFileSync(name, buffer);
        console.log("Saved " + name + " (" + buffer.length + " bytes)");
    });
});
```

---------------------------------------

<a name="editComment"></a>
### api.editComment(postID, commentID, message[, callback])

Edits a comment the logged-in account wrote on a Facebook post.

__Arguments__

* `postID`: The ID of the post the comment is on.
* `commentID`: The numeric comment ID.
* `message`: String with the new comment body (or an object with a `body` field).
* `callback(err, comment)`: Called with `{postID, commentID, body}`.

__Example__

```js
api.editComment("1608281820936422", "1608303754267562", "Actually, great one!", (err) => {
    if(err) return console.error(err);
});
```

---------------------------------------

<a name="editGroupPost"></a>
### api.editGroupPost(postID, message[, options][, callback])

Edits the text of a Facebook post (author or admin).

__Arguments__

* `postID`: The ID of the post.
* `message`: String with the new post body.
* `options`: Optional; `authorID` is the post author's user ID (defaults to the logged-in account); see [`api.deleteGroupPost`](#deleteGroupPost).
* `callback(err, result)`: Called with `{postID, body}`.

---------------------------------------

<a name="followGroup"></a>
### api.followGroup(groupID[, callback])

Starts following a Facebook Group (its posts show up in the home feed).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, result)`: Called with `{groupID, following: true}`.

---------------------------------------

<a name="unfollowGroup"></a>
### api.unfollowGroup(groupID[, callback])

Stops following a Facebook Group.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, result)`: Called with `{groupID, following: false}`.

---------------------------------------

<a name="forwardAttachment"></a>
### api.forwardAttachment(attachmentID, userOrUsers[, callback])

Forwards corresponding attachment to given userID or to every user from an array of userIDs

__Arguments__
* `attachmentID`: The ID field in the attachment object. Recorded audio cannot be forwarded.
* `userOrUsers`: A userID string or usersID string array
* `callback(err)`: A callback called when the query is done (either with an error or null).

---------------------------------------

<a name="getAppState"></a>
### api.getAppState()

Returns current appState which can be saved to a file or stored in a variable.

---------------------------------------

<a name="getCurrentUserID"></a>
### api.getCurrentUserID()

Returns the currently logged-in user's Facebook user ID.

---------------------------------------

<a name="getEmojiUrl"></a>
### api.getEmojiUrl(c, size[, pixelRatio])

Returns the URL to a Facebook Messenger-style emoji image asset.

__note__: This function will return a URL regardless of whether the image at the URL actually exists.
This can happen if, for example, Messenger does not have an image asset for the requested emoji.

__Arguments__

* `c` - The emoji character
* `size` - The width and height of the emoji image; supported sizes are 32, 64, and 128
* `pixelRatio` - The pixel ratio of the emoji image; supported ratios are '1.0' and '1.5' (default is '1.0')

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    // Prints https://static.xx.fbcdn.net/images/emoji.php/v8/z9c/1.0/128/1f40d.png
    console.log('Snake emoji, 128px (128x128 with pixel ratio of 1.0');
    console.log(api.getEmojiUrl('\ud83d\udc0d', 128));

    // Prints https://static.xx.fbcdn.net/images/emoji.php/v8/ze1/1.5/128/1f40d.png
    console.log('Snake emoji, 192px (128x128 with pixel ratio of 1.5');
    console.log(api.getEmojiUrl('\ud83d\udc0d', 128, '1.5'));
});
```

---------------------------------------

<a name="getFeed"></a>
### api.getFeed([amount][, options][, callback])

Returns posts from the logged-in account's home news feed (as shown on facebook.com). Uses Facebook's internal GraphQL API, so the operation ID can change when Facebook ships a new frontend.

__Arguments__

* `amount`: Optional number of posts to request (default 5).
* `options`: Optional object; `cursor` continues from a previous call's `pageInfo.endCursor`.
* `callback(err, posts, pageInfo)`: Called with an array of posts and `pageInfo` `{endCursor, hasNextPage}`. Each post has the fields `postID`, `senderID`, `senderName`, `body`, `timestamp` (milliseconds), `url`, `reactionCount`, `commentCount` and `shareCount`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.getFeed(5, (err, posts, pageInfo) => {
        if(err) return console.error(err);
        posts.forEach(post => console.log(post.senderName + ": " + post.body));

        api.getFeed(5, {cursor: pageInfo.endCursor}, (err2, more) => {
            if(err2) return console.error(err2);
            console.log("next page:", more.length);
        });
    });
});
```

---------------------------------------

<a name="getFriendsList"></a>
### api.getFriendsList(callback)

Returns an array of objects with some information about your friends.

__Arguments__

* `callback(err, arr)` - A callback called when the query is done (either with an error or with an confirmation object). `arr` is an array of objects with the following fields: `alternateName`, `firstName`, `gender`, `userID`, `isFriend`, `fullName`, `profilePicture`, `type`, `profileUrl`, `vanity`, `isBirthday`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.getFriendsList((err, data) => {
        if(err) return console.error(err);

        console.log(data.length);
    });
});
```

---------------------------------------

<a name="getGroupEvents"></a>
### api.getGroupEvents(groupID[, amount][, callback])

Returns a Facebook Group's events (upcoming and past), newest first per section. Requires the group's Events feature to be enabled; an empty array is returned otherwise.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `amount`: Optional number of events to request (default 3).
* `options`: Optional object:
  * `section`: `"upcoming"` (default) or `"past"`.
  * `cursor`: Cursor from a previous call to fetch the next page of a section (requires `section`).
* `callback(err, events, pageInfo)`: Called with an array of events and pagination info. Without a cursor, `pageInfo` is `{upcoming, past}`, each `{endCursor, hasNextPage}`; with a cursor, it's a single `{endCursor, hasNextPage}` for that section. Each event has `eventID`, `name`, `url`, `startTimestamp`, `endTimestamp`, `place`, `isPast`.

__Example__

```js
api.getGroupEvents("123456789", 10, (err, events, pageInfo) => {
    if(err) return console.error(err);
    if (pageInfo.upcoming && pageInfo.upcoming.hasNextPage) {
        api.getGroupEvents("123456789", 10, {section: "upcoming", cursor: pageInfo.upcoming.endCursor}, (err2, more) => {
            if(err2) return console.error(err2);
            console.log("more upcoming events:", more.length);
        });
    }
});
```

---------------------------------------

<a name="getGroupFiles"></a>
### api.getGroupFiles(groupID[, callback])

Returns files shared in a Facebook Group's Files tab. Requires the group's Files feature and uploads to exist; an empty array is returned otherwise.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `options`: Optional object:
  * `cursor`: Cursor from a previous call's `pageInfo.endCursor` to fetch the next page.
  * `name`: Filter by file name.
  * `orderby`: Optional ordering value.
  * `amount`: Page size when using a cursor (default 15).
* `callback(err, files, pageInfo)`: Called with an array of files and `pageInfo` `{endCursor, hasNextPage}`. Each file has `fileID`, `name`, `url`, `type`, `modifiedTime`, `uploader` (`{userID, name}`).

---------------------------------------

<a name="getGroupInfo"></a>
### api.getGroupInfo(groupID[, callback])

Returns information about a Facebook Group: name, url, description, privacy and discoverability, member count, whether the logged-in account is a member/admin, its join state, follow (subscribe) status and whether the group is pinned to the top of the groups list.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, info)`: Called with the group info object.

__Example__

```js
api.getGroupInfo("1608281640936440", (err, info) => {
    if(err) return console.error(err);
    console.log(info.name, "|", info.privacy, "|", info.memberCount, "members");
});
```

---------------------------------------

<a name="getGroupMedia"></a>
### api.getGroupMedia(groupID[, amount][, callback])

Returns photos and videos from a Facebook Group's Media tab, newest first.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `amount`: Optional number of items to request (default 8).
* `callback(err, items)`: Called with an array of items. Each item has `id`, `type` (`"photo"` or `"video"`), `image` (preview URL), `width`, `height` and `url`.

__Example__

```js
api.getGroupMedia("750279539095674", 8, (err, items) => {
    if(err) return console.error(err);
    items.forEach(item => console.log(item.type, item.id));
});
```

---------------------------------------

<a name="getGroupMembers"></a>
### api.getGroupMembers(groupID[, amount][, callback])

Returns members of a Facebook Group. Facebook's group UI serves the People tab through its member search, so this returns a sample of members (recently joined/active) in the same order the UI shows them; use [`api.searchGroupMembers`](#searchGroupMembers) to look for specific people.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `amount`: Optional number of members to request (default 20).
* `callback(err, members)`: Called with an array of members. Each member has `userID`, `name`, `url`, `joinedText` (e.g. `"Joined about 5 months ago"`), `city` (profile bio/location when public) and `profilePicture`.

__Example__

```js
api.getGroupMembers("750279539095674", 20, (err, members) => {
    if(err) return console.error(err);
    members.forEach(m => console.log(m.userID, m.name, m.joinedText));
});
```

---------------------------------------

<a name="getGroupPosts"></a>
### api.getGroupPosts(groupID[, amount][, options][, callback])

Returns posts from a Facebook Group's feed (not a Messenger group chat; see [`api.getThreadHistory`](#getThreadHistory) for chats). Posts are returned newest first. Uses Facebook's internal GraphQL API, so the operation ID can change when Facebook ships a new frontend.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `amount`: Optional number of posts to request (default 10).
* `options`: Optional object:
  * `cursor`: Cursor from a previous call's `pageInfo.endCursor` to fetch the next page.
  * `sortingSetting`: `"CHRONOLOGICAL"` (default) or `"RECENT_ACTIVITY"`.
* `callback(err, posts, pageInfo)`: Called with an array of posts and a `pageInfo` object `{endCursor, hasNextPage}`. Pass `pageInfo.endCursor` as `options.cursor` for the next page. Each post has the fields `postID`, `groupID`, `senderID`, `senderName`, `body`, `timestamp` (milliseconds), `url`, `reactionCount`, `commentCount` and `shareCount`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.getGroupPosts("1608281640936440", 10, (err, posts, pageInfo) => {
        if(err) return console.error(err);
        console.log("first page:", posts.length, "| more:", pageInfo.hasNextPage);

        // Next page:
        api.getGroupPosts("1608281640936440", 10, {cursor: pageInfo.endCursor}, (err2, more) => {
            if(err2) return console.error(err2);
            console.log("second page:", more.length);
        });
    });
});
```

---------------------------------------

<a name="getGroupRules"></a>
### api.getGroupRules(groupID[, callback])

Returns a Facebook Group's rules (the "Group rules from the admins" list).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, rules)`: Called with an array of rules: `ruleID`, `position`, `title`, `description`.

__Example__

```js
api.getGroupRules("750279539095674", (err, rules) => {
    if(err) return console.error(err);
    rules.forEach(rule => console.log(rule.position + ". " + rule.title));
});
```

---------------------------------------

<a name="getPostComments"></a>
### api.getPostComments(postID[, amount][, options][, callback])

Returns the comments on a Facebook post, oldest first, including replies.

__Arguments__

* `postID`: The ID of the post.
* `amount`: Optional number of comments to request (default 10).
* `options`: Optional object:
  * `feedLocation` (default `"GROUP"`) can be set when the post is in a different surface.
  * `cursor` continues from a previous call's `pageInfo.endCursor`.
* `callback(err, comments, pageInfo)`: Called with an array of comments and `pageInfo` `{endCursor, hasNextPage}`. Each comment has `commentID` (numeric), `postID`, `senderID`, `senderName`, `body`, `timestamp` (milliseconds), `reactionCount`, `replyCount` and `isReply`.

__Example__

```js
api.getPostComments("1608283550936249", 50, (err, comments, pageInfo) => {
    if(err) return console.error(err);
    comments.forEach(c => console.log(c.senderName + ": " + c.body));

    if (pageInfo.hasNextPage) {
        api.getPostComments("1608283550936249", 50, {cursor: pageInfo.endCursor}, (err2, more) => {
            if(err2) return console.error(err2);
            console.log("more comments:", more.length);
        });
    }
});
```

---------------------------------------

<a name="getPostReactions"></a>
### api.getPostReactions(postID[, options][, callback])

Returns the people who reacted to a post (the first batch, as shown in the reactions dialog).

__Arguments__

* `postID`: The ID of the post.
* `options`: Optional object:
  * `reaction`: filters by a specific reaction (`"LIKE"`, `"LOVE"`, `"HAHA"`, `"WOW"`, `"SAD"`, `"ANGRY"`, `"CARE"`).
  * `cursor`: continues from a previous call's `pageInfo.endCursor` (used when Facebook reports `hasNextPage: true`).
* `callback(err, users, pageInfo)`: Called with an array of `{userID, name, url, type}` and `pageInfo` `{endCursor, hasNextPage}` when Facebook provides one.

---------------------------------------

<a name="getThreadHistory"></a>
### api.getThreadHistory(threadID, amount, timestamp, callback)

Takes a threadID, number of messages, a timestamp, and a callback.

__note__: if you're getting a 500 error, it's possible that you're requesting too many messages. Try reducing that number and see if that works.

__End-to-end encrypted chats__: Facebook does not expose a plaintext history for chats that have been moved to E2EE, so the GraphQL query returns no thread for them. In that case this method reads the account's encrypted backup when it has been restored (see [`api.restoreE2EEBackup`](#restoreE2EEBackup)): backup messages are fetched, decrypted and returned as ordinary history entries (one-to-one text messages and admin events; sender ids come from the backup's message metadata). If no backup has been restored, this method falls back to messages this library has cached locally in the E2EE device file (see `e2eeDevicePath` in [api.setOptions](#setOptions)): text sent through this library and text received and decrypted by it while the E2EE client was connected. History from before this device registered, attachments and received message reactions are not available. If the chat is E2EE and nothing is available, an error is returned instead of an empty list.

__Arguments__
* `threadID`: A threadID corresponding to the target chat
* `amount`: The amount of messages to *request*
* `timestamp`: Used to described the time of the most recent message to load. If timestamp is `undefined`, facebook will load the most recent messages.
* `callback(error, history)`: If error is null, history will contain an array of message objects.

__Example__

To load 50 messages at a time, we can use `undefined` as the timestamp to retrieve the most recent messages and use the timestamp of the earliest message to load the next 50.

```js
var timestamp = undefined;

function loadNextThreadHistory(api){
    api.getThreadHistory(threadID, 50, timestamp, (err, history) => {
        if(err) return console.error(err);

        /*
            Since the timestamp is from a previous loaded message,
            that message will be included in this history so we can discard it unless it is the first load.
        */
        if(timestamp != undefined) history.pop();

        /*
            Handle message history
        */

        timestamp = history[0].timestamp;
    });
}
```

---------------------------------------

<a name="getThreadInfo"></a>
### api.getThreadInfo(threadID[, callback])

Takes a threadID and a callback.  Works for both single-user and group threads.

__Arguments__
* `threadID`: A threadID corresponding to the target thread.
* `callback(err, info)`: If `err` is `null`, `info` will contain the following properties: * `callback(err, arr)`: A callback called when the query is done (either with an error or with an confirmation object). `arr` is an array of thread object containing the following properties:

| Key   |      Description      |
|----------|:-------------:|
| threadID | ID of the thread |
| participantIDs |    Array of user IDs in the thread   |
| name | Name of the thread. Usually the name of the user. In group chats, this will be empty if the name of the group chat is unset. |
| nicknames |    Map of nicknames for members of the thread. If there are no nicknames set, this will be null.   |
| unreadCount | Number of unread messages |
| messageCount | Number of messages |
| imageSrc | URL to the group chat photo. Null if unset or a 1-1 thread. |
| timestamp |  |
| muteUntil | Timestamp at which the thread will no longer be muted. The timestamp will be -1 if the thread is muted indefinitely or null if the thread is not muted. |
| isGroup | boolean, true if this thread is a group thread (more than 2 participants). |
| isSubscribed |  |
| folder | The folder that the thread is in. Can be one of: <ul><li>'inbox'</li><li>'archive'</li></ul> |
| isArchived | True if the thread is archived, false if not |
| cannotReplyReason | If you cannot reply to this thread, this will be a string stating why. Otherwise it will be null. |
| lastReadTimestamp | Timestamp of the last message that is marked as 'read' by the current user. |
| emoji | Object with key 'emoji' whose value is the emoji unicode character. Null if unset. |
| color | String form of the custom color in hexadecimal form. |
| adminIDs | Array of user IDs of the admins of the thread. Empty array if unset. |

---------------------------------------

<a name="getThreadList"></a>
### api.getThreadList(limit, timestamp, tags, callback)

Returns information about the user's threads.

__Arguments__

* `limit`: Limit the number of threads to fetch.
* `timestamp`: Request threads *before* this date. `null` means *now*
* `tags`: An array describing which folder to fetch. It should be one of these:
  - `["INBOX"]` *(same as `[]`)*
  - `["ARCHIVED"]`
  - `["PENDING"]`
  - `["OTHER"]`
  - `["INBOX", "unread"]`
  - `["ARCHIVED", "unread"]`
  - `["PENDING", "unread"]`
  - `["OTHER", "unread"]`

*if you find something new, let us know*

* `callback(err, list)`: Callback called when the query is done (either with an error or with a proper result). `list` is an *array* with objects with the following properties:

__Thread list__

| Key                  | Description                                                 |
|----------------------|-------------------------------------------------------------|
| threadID             | ID of the thread                                            |
| name                 | The name of the thread                                      |
| unreadCount          | Amount of unread messages in thread                         |
| messageCount         | Amount of messages in thread                                |
| imageSrc             | Link to the thread's image or `null`                        |
| emoji                | The default emoji in thread (classic like is `null`)        |
| color                | Thread's message color in `RRGGBB` (default blue is `null`) |
| nicknames            | An array of `{"userid": "1234", "nickname": "John Doe"}`    |
| muteUntil            | Timestamp until the mute expires or `null`                  |
| participants         | An array of participants. See below                         |
| adminIDs             | An array of thread admin IDs                                |
| folder               | `INBOX`, `ARCHIVED`, `PENDING` or `OTHER`                   |
| isGroup              | `true` or `false`                                           |
| customizationEnabled | `false` in one-to-one conversations with `Page` or `ReducedMessagingActor` |
| participantAddMode   | currently `"ADD"` for groups and `null` otherwise           |
| reactionsMuteMode    | `REACTIONS_NOT_MUTED` or `REACTIONS_MUTED`                  |
| mentionsMuteMode     | `MENTIONS_NOT_MUTED` or `MENTIONS_MUTED`                    |
| isArchived           | `true` or `false`                                           |
| isSubscribed         | `true` or `false`                                           |
| timestamp            | timestamp in miliseconds                                    |
| snippet              | Snippet's text message                                      |
| snippetAttachments   | Attachments in snippet                                      |
| snippetSender        | ID of snippet sender                                        |
| lastMessageTimestamp | timestamp in milliseconds                                   |
| lastReadTimestamp    | timestamp in milliseconds or `null`                         |
| cannotReplyReason    | `null`, `"RECIPIENTS_NOT_LOADABLE"` or `"BLOCKED"`          |

__`participants` format__

`accountType` is one of the following:
- `"User"`
- `"Page"`
- `"UnavailableMessagingActor"`
- `"ReducedMessagingActor"`

(*there might be more*)

<table>
<tr>
<th>Account type</th>
<th>Key</th>
<th>Description</th>
</tr>
<tr>
<td rowspan="12"><code>"User"</code></td>
<td>userID</td>
<td>ID of user</td>
</tr>
<tr>
<td>name</td>
<td>Full name of user</td>
</tr>
<tr>
<td>shortName</td>
<td>Short name of user (most likely first name)</td>
</tr>
<tr>
<td>gender</td>
<td>Either
<code>"MALE"</code>,
<code>"FEMALE"</code>,
<code>"NEUTER"</code> or
<code>"UNKNOWN"</code>
</td>
</tr>
<tr>
<td>url</td>
<td>URL of the user's Facebook profile</td>
</tr>
<tr>
<td>profilePicture</td>
<td>URL of the profile picture</td>
</tr>
<tr>
<td>username</td>
<td>Username of user or
<code>null</code>
</td>
</tr>
<tr>
<td>isViewerFriend</td>
<td>Is the user a friend of you?</td>
</tr>
<tr>
<td>isMessengerUser</td>
<td>Does the user use Messenger?</td>
</tr>
<tr>
<td>isVerified</td>
<td>Is the user verified? (Little blue tick mark)</td>
</tr>
<tr>
<td>isMessageBlockedByViewer</td>
<td>Is the user blocking messages from you?</td>
</tr>
<tr>
<td>isViewerCoworker</td>
<td>Is the user your coworker?
</td>
</tr>

<tr>
<td rowspan="10"><code>"Page"</code></td>
<td>userID</td>
<td>ID of the page</td>
</tr>
<tr>
<td>name</td>
<td>Name of the fanpage</td>
</tr>
<tr>
<td>url</td>
<td>URL of the fanpage</td>
</tr>
<tr>
<td>profilePicture</td>
<td>URL of the profile picture</td>
</tr>
<tr>
<td>username</td>
<td>Username of user or
<code>null</code>
</td>
</tr>
<tr>
<td>acceptsMessengerUserFeedback</td>
<td></td>
</tr>
<tr>
<td>isMessengerUser</td>
<td>Does the fanpage use Messenger?</td>
</tr>
<tr>
<td>isVerified</td>
<td>Is the fanpage verified? (Little blue tick mark)</td>
</tr>
<tr>
<td>isMessengerPlatformBot</td>
<td>Is the fanpage a bot</td>
</tr>
<tr>
<td>isMessageBlockedByViewer</td>
<td>Is the fanpage blocking messages from you?</td>
</tr>

<tr>
<td rowspan="7"><code>"ReducedMessagingActor"</code><br />(account requres verification,<br />messages are hidden)</td>
<td>userID</td>
<td>ID of the user</td>
</tr>
<tr>
<td>name</td>
<td>Name of the user</td>
</tr>
<tr>
<td>url</td>
<td>
<code>null</code>
</td>
</tr>
<tr>
<td>profilePicture</td>
<td>URL of the default Facebook profile picture</td>
</tr>
<tr>
<td>username</td>
<td>Username of user</td>
</td>
</tr>
<tr>
<td>acceptsMessengerUserFeedback</td>
<td></td>
</tr>
<tr>
<td>isMessageBlockedByViewer</td>
<td>Is the user blocking messages from you?</td>
</tr>
<tr>
<td rowspan="7"><code>"UnavailableMessagingActor"</code><br />(account disabled/removed)</td>
<td>userID</td>
<td>ID of the user</td>
</tr>
<tr>
<td>name</td>
<td><em>Facebook User</em> in user's language</td>
</tr>
<tr>
<td>url</td>
<td><code>null</code></td>
</tr>
<tr>
<td>profilePicture</td>
<td>URL of the default **male** Facebook profile picture</td>
</tr>
<tr>
<td>username</td>
<td><code>null</code></td>
</tr>
<tr>
<td>acceptsMessengerUserFeedback</td>
<td></td>
</tr>
<tr>
<td>isMessageBlockedByViewer</td>
<td>Is the user blocking messages from you?</td>
</tr>
</table>


In a case that some account type is not supported, we return just this *(but you can't rely on it)* and log a warning to the console:

| Key          | Description             |
|--------------|-------------------------|
| accountType  | type, can be anything   |
| userID       | ID of the account       |
| name         | Name of the account     |


---------------------------------------

<a name="getThreadPictures"></a>
### api.getThreadPictures(threadID, offset, limit, callback)

Returns pictures sent in the thread.

__Arguments__

* `threadID`: A threadID corresponding to the target chat
* `offset`: Start index of picture to retrieve, where 0 is the most recent picture
* `limit`: Number of pictures to get, incrementing from the offset index
* `callback(err, arr)`: A callback called when the query is done (either with an error or with an confirmation object). `arr` is an array of objects with `uri`, `width`, and `height`.

---------------------------------------

<a name="getUserID"></a>
### api.getUserID(name, callback)

Given the full name or vanity name of a Facebook user, event, page, group or app, the call will perform a Facebook Graph search and return all corresponding IDs (order determined by Facebook).

__Arguments__

* `name` - A string being the name of the item you're looking for.
* `callback(err, obj)` - A callback called when the search is done (either with an error or with the resulting object). `obj` is an array which contains all of the items that facebook graph search found, ordered by "importance".  Each item in the array has the following properties: `userID`,`photoUrl`,`indexRank`, `name`, `isVerified`, `profileUrl`, `category`, `score`, `type` (type is generally user, group, page, event or app).

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.getUserID("Marc Zuckerbot", (err, data) => {
        if(err) return console.error(err);

        // Send the message to the best match (best by Facebook's criteria)
        var msg = "Hello!"
        var threadID = data[0].userID;
        api.sendMessage(msg, threadID);
    });
});
```

---------------------------------------

<a name="getUserInfo"></a>
### api.getUserInfo(ids, callback)

Will get some information about the given users.

__Arguments__

* `ids` - Either a string/number for one ID or an array of strings/numbers for a batched query.
* `callback(err, obj)` - A callback called when the query is done (either with an error or with an confirmation object). `obj` is a mapping from userId to another object containing the following properties: `name`, `firstName`, `vanity` (user's chosen facebook handle, if any), `thumbSrc`, `profileUrl`, `gender`, `type` (type is generally user, group, page, event or app), `isFriend`, `isBirthday`, `searchTokens`, `alternateName`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.getUserInfo([1, 2, 3, 4], (err, ret) => {
        if(err) return console.error(err);

        for(var prop in ret) {
            if(ret.hasOwnProperty(prop) && ret[prop].isBirthday) {
                api.sendMessage("Happy birthday :)", prop);
            }
        }
    });
});
```

---------------------------------------

<a name="threadColors"></a>
### api.threadColors

A dictionary mapping names of all currently valid thread colors to their hexadecimal values that are accepted by [`api.changeThreadColor`](#changeThreadColor). These colors, listed below, are the ones present in the palette UI used for selecting thread colors on the Messenger client.

- MessengerBlue: `null`
- Viking: `#44bec7`
- GoldenPoppy: `#ffc300`
- RadicalRed: `#fa3c4c`
- Shocking: `#d696bb`
- PictonBlue: `#6699cc`
- FreeSpeechGreen: `#13cf13`
- Pumpkin: `#ff7e29`
- LightCoral: `#e68585`
- MediumSlateBlue: `#7646ff`
- DeepSkyBlue: `#20cef5`
- Fern: `#67b868`
- Cameo: `#d4a88c`
- BrilliantRose: `#ff5ca1`
- BilobaFlower: `#a695c7`

---------------------------------------

<a name="handleMessageRequest"></a>
### api.handleMessageRequest(threadID, accept[, callback])

Accept or ignore message request(s) with thread id `threadID`.

__Arguments__

* `threadID`: A threadID or array of threadIDs corresponding to the target thread(s). Can be numbers or strings.
* `accept`: Boolean indicating the new status to assign to the message request(s); true for inbox, false to others.
* `callback(err)`: A callback called when the query is done (with an error or with null).

---------------------------------------

<a name="inviteToGroup"></a>
### api.inviteToGroup(groupID, userIDs[, callback])

Invites users to a Facebook Group (requires admin/moderator rights, and the users must be addable — for private groups Facebook only suggests friends).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `userIDs`: A user ID or an array of user IDs to invite.
* `callback(err, result)`: Called with `{groupID, userIDs, invited: true}`.

---------------------------------------

<a name="joinGroup"></a>
### api.joinGroup(groupID[, callback])

Joins a Facebook Group, or sends a join request when the group is private. The result tells which happened through `joined` and `joinState` (`"MEMBER"` after a direct join, `"REQUESTED"` after a request).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, result)`: Called with `{groupID, joined, joinState}`.

---------------------------------------

<a name="leaveGroup"></a>
### api.leaveGroup(groupID[, callback])

Leaves a Facebook Group.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, result)`: Called with `{groupID, left: true}`.

Facebook refuses to let the last remaining admin leave a group (promote another admin first), in which case the callback gets an error.

---------------------------------------

<a name="likePost"></a>
### api.likePost(postID[, callback])

Likes a Facebook post. Shorthand for [`api.setPostReaction`](#setPostReaction)`(postID, "LIKE")`.

__Arguments__

* `postID`: The ID of the post to like.
* `callback(err, result)`: Called with `{postID, reaction}`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.likePost("1608281820936422", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="listen"></a>
### api.listen(callback)

Will call `callback` when a new message is received on this account.
By default this won't receive events (joining/leaving a chat, title change etc...) but it can be activated with `api.setOptions({listenEvents: true})`.  This will by default ignore messages sent by the current account, you can enable listening to your own messages with `api.setOptions({selfListen: true})`. This returns `stopListening` that will stop the `listen` loop and is guaranteed to prevent any future calls to the callback given to `listen`. An immediate call to `stopListening` when an error occurs will prevent the listen function to continue.

__Arguments__

- `callback(error, message)`: A callback called every time the logged-in account receives a new message.

<a name="message"></a>
__Message__

The message object will contain different fields based on its type (as determined by its `type` field). By default, the only type that will be listened for is `message`. If enabled through [setOptions](#setOptions), the message object may alternatively represent an event e.g. a read receipt. The available event types are as follows:

`message`, `typ`, `message_reaction`, `message_unsend`, `message_reply`, `message_edit` and `message_self_delete` are also delivered for end-to-end encrypted one-to-one chats (E2EE), provided the E2EE client is connected (see [api.connectE2EE](#connectE2EE)) and `listenEvents` is on for the event types. The only difference: an E2EE `message_edit.body` carries the new text as typed (no Facebook ` (edited)` suffix).

<table>
	<tr>
		<th>Event Type</th>
		<th>Field</th>
		<th>Description</th>
	</tr>
	<tr>
		<td rowspan="9">
			<code>"message"</code><br />
			A message was sent to a thread.
		</td>
		<td><code>attachments</code></td>
		<td>An array of attachments to the message. Attachments vary in type, see the attachments table below.</td>
	</tr>
	<tr>
		<td><code>body</code></td>
		<td>The string corresponding to the message that was just received.</td>
	</tr>
	<tr>
		<td><code>isGroup</code></td>
		<td>boolean, true if this thread is a group thread (more than 2 participants).</td>
	</tr>
    <tr>
        <td><code>mentions</code></td>
        <td>An object containing people mentioned/tagged in the message in the format { id: name }</td>
    </tr>
	<tr>
		<td><code>messageID</code></td>
		<td>A string representing the message ID.</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>The id of the person who sent the message in the chat with threadID.</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was sent.</td>
	</tr>
  	<tr>
		<td><code>isUnread</code></td>
		<td>Boolean representing whether or not the message was read.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message"</code>.</td>
	</tr>
	<tr>
		<td rowspan="6">
			<code>"event"</code><br />
			An event occurred within a thread.
		</td>
		<td><code>author</code></td>
		<td>The person who performed the event.</td>
	</tr>
	<tr>
		<td><code>logMessageBody</code></td>
		<td>String printed in the chat.</td>
	</tr>
	<tr>
		<td><code>logMessageData</code></td>
		<td>Data relevant to the event.</td>
	</tr>
	<tr>
		<td><code>logMessageType</code></td>
		<td>String representing the type of event (<code>log:subscribe</code>, <code>log:unsubscribe</code>, <code>log:thread-name</code>, <code>log:thread-color</code>, <code>log:thread-icon</code>, <code>log:user-nickname</code>)</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was sent.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"event"</code>.</td>
	</tr>
	<tr>
		<td rowspan="5">
			<code>"typ"</code><br />
			A user in a thread is typing.
		</td>
		<td><code>from</code></td>
		<td>ID of the user who started/stopped typing.</td>
	</tr>
	<tr>
		<td><code>fromMobile</code></td>
		<td>Boolean representing whether or not the person's using a mobile device to type.</td>
	</tr>
	<tr>
		<td><code>isTyping</code></td>
		<td>Boolean representing whether or not a person started typing.</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which a user is typing.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"typ"</code>.</td>
	</tr>
	<tr>
		<td rowspan="3">
			<code>"read"</code><br />
			The current API user has read a message.
		</td>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was sent.</td>
	</tr>
	<tr>
		<td><code>time</code></td>
		<td>The time at which the user read the message.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"read"</code>.</td>
	</tr>
	<tr>
		<td rowspan="4">
			<code>"read_receipt"</code><br />
			A user within a thread has seen a message sent by the API user.
		</td>
		<td><code>reader</code></td>
		<td>ID of the user who just read the message.</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>The thread in which the message was read.</td>
	</tr>
	<tr>
		<td><code>time</code></td>
		<td>The time at which the reader read the message.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"read_receipt"</code>.</td>
	</tr>
	<tr>
		<td rowspan="8">
			<code>"message_reaction"</code><br />
			A user has sent a reaction to a message.
		</td>
		<td><code>messageID</code></td>
		<td>The ID of the message</td>
	</tr>
	<tr>
		<td><code>offlineThreadingID</code></td>
		<td>The offline message ID</td>
	</tr>
	<tr>
		<td><code>reaction</code></td>
		<td>Contains reaction emoji</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>ID of the author the message, where has been reaction added</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>ID of the thread where the message has been sent</td>
	</tr>
	<tr>
		<td><code>timestamp</code></td>
		<td>Unix Timestamp (in miliseconds) when the reaction was sent</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message_reaction"</code>.</td>
	</tr>
	<tr>
		<td><code>userID</code></td>
		<td>ID of the reaction sender</td>
	</tr>
	<tr>
		<td rowspan="4"><a name="presence"></a>
			<code>"presence"</code><br />
			The online status of the user's friends. Note that receiving this event type needs to be enabled with <code>api.setOptions({ updatePresence: true })</code>
		</td>
		<td><code>statuses</code></td>
		<td>The online status of the user. <code>0</code> means the user is idle (away for 2 minutes) and <code>2</code> means the user is online (we don't know what 1 or above 2 means...).</td>
	</tr>
	<tr>
		<td><code>timestamp</code></td>
		<td>The time when the user was last online.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"presence"</code>.</td>
	</tr>
	<tr>
		<td><code>userID</code></td>
		<td>The ID of the user whose status this packet is describing.</td>
	</tr>
	<tr>
		<td rowspan="5">
			<code>"message_unsend"</code><br />
			A revoke message request for a message from a thread was received.
		</td>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the revoke message request was received.</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>The id of the person who request to revoke message on threadID.</td>
	</tr>
	<tr>
		<td><code>messageID</code></td>
		<td>A string representing the message ID that the person request to revoke message want to.</td>
	</tr>
	<tr>
		<td><code>deletionTimestamp</code></td>
		<td>The time when the request was sent.</td>
    </tr>
    <tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message_unsend"</code>.</td>
	</tr>
	<tr>
		<td rowspan="10">
			<code>"message_reply"</code><br />
			A reply message was sent to a thread.
		</td>
		<td><code>attachments</code></td>
		<td>An array of attachments to the message. Attachments vary in type, see the attachments table below.</td>
	</tr>
	<tr>
		<td><code>body</code></td>
		<td>The string corresponding to the message that was just received.</td>
	</tr>
	<tr>
		<td><code>isGroup</code></td>
		<td>boolean, true if this thread is a group thread (more than 2 participants).</td>
	</tr>
    <tr>
        <td><code>mentions</code></td>
        <td>An object containing people mentioned/tagged in the message in the format { id: name }</td>
    </tr>
	<tr>
		<td><code>messageID</code></td>
		<td>A string representing the message ID.</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>The id of the person who sent the message in the chat with threadID.</td>
	</tr>
	<tr>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was sent.</td>
	</tr>
  	<tr>
		<td><code>isUnread</code></td>
		<td>Boolean representing whether or not the message was read.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message_reply"</code>.</td>
	</tr>
	<tr>
		<td><code>messageReply</code></td>
		<td>An object represent a message being replied. Content inside is the same like a normal <code>"message"</code> event.</td>
	</tr>
	<tr>
		<td rowspan="7">
			<code>"message_edit"</code><br />
			A message was edited. Facebook doesn't push the edit itself, so this is detected by refetching the last messages of the most recently active thread after a <code>NoOp</code> delta; the new body includes Facebook's <code> (edited)</code> suffix. Needs <code>api.setOptions({ listenEvents: true })</code>.
		</td>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was edited.</td>
	</tr>
	<tr>
		<td><code>messageID</code></td>
		<td>A string representing the message ID that was edited.</td>
	</tr>
	<tr>
		<td><code>body</code></td>
		<td>The new body of the message.</td>
	</tr>
	<tr>
		<td><code>previousBody</code></td>
		<td>The body the message had before the edit.</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>The id of the person who sent the message.</td>
	</tr>
	<tr>
		<td><code>timestamp</code></td>
		<td>The time the original message was sent.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message_edit"</code>.</td>
	</tr>
	<tr>
		<td rowspan="6">
			<code>"message_self_delete"</code><br />
			A message was deleted for the current account only ("remove for you"), usually by the account itself. Needs <code>api.setOptions({ listenEvents: true })</code>.
		</td>
		<td><code>threadID</code></td>
		<td>The threadID representing the thread in which the message was deleted.</td>
	</tr>
	<tr>
		<td><code>messageID</code></td>
		<td>A string, or an array of strings, representing the message ID(s) that were deleted.</td>
	</tr>
	<tr>
		<td><code>senderID</code></td>
		<td>The id of the account that deleted the message.</td>
	</tr>
	<tr>
		<td><code>deletionTimestamp</code></td>
		<td>The time when the request was sent.</td>
	</tr>
	<tr>
		<td><code>timestamp</code></td>
		<td>The time the deleted message was sent.</td>
	</tr>
	<tr>
		<td><code>type</code></td>
		<td>For this event type, this will always be the string <code>"message_self_delete"</code>.</td>
	</tr>
</table>

__Attachments__

Similar to how messages can vary based on their `type`, so too can the `attachments` within `"message"` events. Each attachment will consist of an object of one of the following types:

| Attachment Type | Fields |
| --------------- | ------ |
| `"sticker"` | `ID`, `url`, `packID`, `spriteUrl`, `spriteUrl2x`, `width`, `height`, `caption`, `description`, `frameCount`, `frameRate`, `framesPerRow`, `framesPerCol` |
| `"file"` | `ID`, `filename`, `url`, `isMalicious`, `contentType` |
| `"photo"` | `ID`, `filename`, `thumbnailUrl`, `previewUrl`, `previewWidth`, `previewHeight`, `largePreviewUrl`, `largePreviewWidth`, `largePreviewHeight` |
| `"animated_image"` | `ID`, `filename`, `previewUrl`, `previewWidth`, `previewHeight`, `url`, `width`, `height` |
| `"video"` | `ID`, `filename`, `previewUrl`, `previewWidth`, `previewHeight`, `url`, `width`, `height`, `duration`, `videoType` |
| `"audio"` | `ID`, `filename`, `audioType`, `duration`, `url`, `isVoiceMail` |
| `"share"` | `ID`, `url`, `title`, `description`, `source`, `image`, `width`, `height`, `playable`, `duration`, `playableUrl`, `subattachments`, `properties` |

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

// Simple echo bot. He'll repeat anything that you say.
// Will stop when you say '/stop'

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.setOptions({listenEvents: true});

    var stopListening = api.listen((err, event) => {
        if(err) return console.error(err);

        switch(event.type) {
            case "message":
                if(event.body === '/stop') {
                    api.sendMessage("Goodbye...", event.threadID);
                    return stopListening();
                }
                api.markAsRead(event.threadID, (err) => {
                    if(err) console.log(err);
                });
                api.sendMessage("TEST BOT: " + event.body, event.threadID);
                break;
            case "event":
                console.log(event);
                break;
        }
    });
});
```

---------------------------------------

<a name="listenMqtt"></a>
### api.listenMqtt(callback) (Experimental)
Same as [`api.listen`](#listen) but uses MQTT to recieve data.

Will call `callback` when a new message is received on this account.
By default this won't receive events (joining/leaving a chat, title change etc...) but it can be activated with `api.setOptions({listenEvents: true})`.  This will by default ignore messages sent by the current account, you can enable listening to your own messages with `api.setOptions({selfListen: true})`. This returns `stopListening` that will stop the `listen` loop and is guaranteed to prevent any future calls to the callback given to `listenMqtt`. An immediate call to `stopListening` when an error occurs will prevent the listen function to continue.

End-to-end encrypted direct messages are also delivered to this callback while the E2EE client is connected — either explicitly via [`api.connectE2EE`](#connectE2EE) or automatically after the first encrypted send. They arrive as ordinary `message` events, decrypted. See [api.sendMessage](#sendMessage) for details.


__Arguments__

- `callback(error, message)`: A callback called every time the logged-in account receives a new message.

Messages and Events are the same as [`api.listen`](#listen)

---------------------------------------

<a name="logout"></a>
### api.logout([callback])

Logs out the current user.

__Arguments__

* `callback(err)`: A callback called when the query is done (either with an error or with null).

---------------------------------------

<a name="markAsDelivered"></a>
### api.markAsDelivered(threadID, messageID[, callback]])

Given a threadID and a messageID will mark that message as delivered. If a message is marked as delivered that tells facebook servers that it was recieved.

You can also mark new messages as delivered automatically. This is enabled by default. See [api.setOptions](#setOptions).

__Arguments__

* `threadID` - The id of the thread in which you want to mark the message as delivered.
* `messageID` - The id of the message want to mark as delivered.
* `callback(err)` - A callback called when the operation is done maybe with an object representing an error.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        if(err) return console.error(err);

        // Marks messages as delivered immediately after they're received
        api.markAsDelivered(message.threadID, message.messageID);
    });
});
```

---------------------------------------

<a name="markAsRead"></a>
### api.markAsRead(threadID, [read[, callback]])

Given a threadID will mark all the unread messages as read. Facebook will take a couple of seconds to show that you've read the messages.

This publishes the same Lightspeed read-watermark tasks the Messenger web client sends (labels 49 and 21); the old `/ajax/mercury/change_read_status.php` endpoint no longer exists. Passing `read: false` marks the thread unread, same as [`api.markAsUnread`](#markAsUnread).

You can also mark new messages as read automatically. See [api.setOptions](#setOptions).

__Arguments__

* `threadID` - The id of the thread in which you want to mark the messages as read.
* `read` - An optional boolean where `true` means to mark the message as being "read" and `false` means to mark the message as being "unread".
* `callback(err)` - A callback called when the operation is done maybe with an object representing an error.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        if(err) return console.error(err);

        // Marks messages as read immediately after they're received
        api.markAsRead(message.threadID);
    });
});
```

---------------------------------------

<a name="markAsUnread"></a>
### api.markAsUnread(threadID[, unreadSinceMs][, callback])

Marks a chat as unread, exactly the way the "Mark as unread" item in the web client does: the read watermark (Lightspeed task, label 49) is rolled back so the newest message shows as unread again.

__Arguments__

* `threadID` - The id of the thread to mark unread.
* `unreadSinceMs` - Optional absolute millisecond timestamp: every message after it counts as unread. Without it the watermark is placed just before the thread's last message, so only the newest message is unread (matching what the UI does when one message arrived).
* `callback(err, result)` - Called with `{threadID, read: false, watermarkTimestampMs}`.

__Example__

```js
api.markAsUnread(message.threadID, (err, result) => {
    if(err) return console.error(err);
    console.log("unread again:", result);
});
```

---------------------------------------

<a name="markAsReadAll"></a>
### api.markAsReadAll([callback]])

This function will mark all of messages in your inbox readed.

It publishes the modern read-watermark tasks (the same ones [`api.markAsRead`](#markAsRead) uses) for the threads listed in the `INBOX`, `OTHER` and `PENDING` folders; the old `/ajax/mercury/mark_folder_as_read.php` endpoint is gone. The callback receives `{threads, tasks}` with how many threads were listed and tasks published.

---------------------------------------

<a name="markGroupVisited"></a>
### api.markGroupVisited(groupID[, callback])

Marks a Facebook Group as visited, clearing its unread badge on the groups tab.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `callback(err, result)`: Called with `{groupID, visited: true}`.

---------------------------------------

<a name="muteThread"></a>
### api.muteThread(threadID, muteSeconds[, callback])

Mute a chat for a period of time, or unmute a chat.

This publishes the Lightspeed mute task (label 144) the web client sends; the old `/ajax/mercury/change_mute_thread.php` endpoint is gone. The task wants an absolute deadline, so `muteSeconds` is converted to `Date.now() + muteSeconds * 1000`; a value that is already an absolute millisecond timestamp (> 10^12) is passed through unchanged.

__Arguments__

* `threadID` - The ID of the chat you want to mute.
* `muteSeconds` - Mute the chat for this amount of seconds. Use `0` to unmute a chat. Use '-1' to mute a chat indefinitely. An absolute millisecond timestamp is also accepted.
* `callback(err, result)` - Called with `{threadID, muted, muteExpireTimeMs}`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        if(err) return console.error(err);

        // Mute all incoming chats for one minute
        api.muteThread(message.threadID, 60);
    });
});
```

---------------------------------------

<a name="pinGroupPost"></a>
### api.pinGroupPost(postID[, options][, callback])

Pins a post to the top of a Facebook Group's feed ("Pin to Featured"). Requires admin rights.

This uses the same mutation as the web client's "Pin to Featured" menu item; Facebook resolves one unrelated response field inconsistently (`field_type_no_match` on the featured-units list), which the web client ignores and this library does too.

__Arguments__

* `postID`: The ID of the post.
* `options`: Optional; `authorID` is the post author's user ID (defaults to the logged-in account), and `groupID` is the group's ID (the web client sends it with the pin); see [`api.deleteGroupPost`](#deleteGroupPost).
* `callback(err, result)`: Called with `{postID, pinned: true}`.

---------------------------------------

<a name="removeGroupMember"></a>
### api.removeGroupMember(groupID, userID[, callback])

Removes (and by default does not block) a member from a Facebook Group. Requires admin/moderator rights. Facebook refuses to remove the last admin.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `userID`: The ID of the member to remove.
* `callback(err, result)`: Called with `{groupID, userID, removed: true}`.

---------------------------------------

<a name="removeUserFromGroup"></a>
### api.removeUserFromGroup(userID, threadID[, callback])

Removes a user from a group chat.

__Arguments__

* `userID`: User ID.
* `threadID`: Group chat ID.
* `callback(err)`: A callback called when the query is done (either with an error or with no arguments).

---------------------------------------

<a name="resolvePhotoUrl"></a>
### api.resolvePhotoUrl(photoID, callback)

Resolves the URL to the full-size photo, given its ID. This function is useful for retrieving the full-size photo URL
of image attachments in messages, returned by [`api.getThreadHistory`](#getThreadHistory).

__Arguments__

* `photoID`: Photo ID.
* `callback(err, url)`: A callback called when the query is done (either with an error or with the photo's URL). `url` is a string with the photo's URL.

---------------------------------------

<a name="searchForThread"></a>
### api.searchForThread(name, callback)

> This part is outdated.
> see #396

Takes a chat title (thread name) and returns matching results as a formatted threads array (ordered according to Facebook).

__Arguments__
* `name`: A messageID string or messageID string array
* `callback(err, obj)`: A callback called when the query is done (either with an error or a thread object). The object passed in the callback has the following shape: `threadID`, <del>`participants`</del>, `participantIDs`, `formerParticipants`, `name`, `nicknames`, `snippet`, `snippetHasAttachment`, `snippetAttachments`, `snippetSender`, `unreadCount`, `messageCount`, `imageSrc`, `timestamp`, `serverTimestamp`, `muteSettings`, `isCanonicalUser`, `isCanonical`, `canonicalFbid`, `isSubscribed`, `rootMessageThreadingID`, `folder`, `isArchived`, `recipientsLoadable`, `hasEmailParticipant`, `readOnly`, `canReply`, `composerEnabled`, `blockedParticipants`, `lastMessageID`

---------------------------------------

<a name="searchGroupMembers"></a>
### api.searchGroupMembers(groupID, query[, amount][, callback])

Searches members of a Facebook Group by name (this is the search behind the group's People tab).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `query`: Search string (empty string returns the default member sample, same as [`api.getGroupMembers`](#getGroupMembers)).
* `amount`: Optional number of results to request (default 20).
* `callback(err, members)`: Called with an array of members in the same format as [`api.getGroupMembers`](#getGroupMembers).

__Example__

```js
api.searchGroupMembers("750279539095674", "Nguyen", 20, (err, members) => {
    if(err) return console.error(err);
    members.forEach(m => console.log(m.userID, m.name, m.city));
});
```

---------------------------------------

<a name="searchGroupPosts"></a>
### api.searchGroupPosts(groupID, query[, amount][, callback])

Searches posts inside a Facebook Group by keyword (the group's own search box).

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `query`: Search string.
* `amount`: Optional number of posts to request (default 5).
* `callback(err, posts)`: Called with an array of posts: `postID`, `senderID`, `senderName`, `body`, `timestamp`, `url`.

__Example__

```js
api.searchGroupPosts("750279539095674", "headphones", 10, (err, posts) => {
    if(err) return console.error(err);
    posts.forEach(p => console.log(p.postID, p.body.slice(0, 60)));
});
```

---------------------------------------

<a name="sendMessage"></a>
### api.sendMessage(message, threadID[, callback][, messageID])

Sends the given message to the threadID.

**Note:** Facebook removed the endpoint this method used to post to. Plain text messages (no attachment, url, sticker, emoji, mentions or reply) are now sent over the MQTT connection, so you must call `api.listenMqtt` first and let it connect. Group chats and legacy one-to-one chats go out over MQTT.

One-to-one chats are end-to-end encrypted by default. When Facebook rejects a plaintext send to such a chat (`cutoverHandleInvalidSendToOpen`), `sendMessage` automatically retries through the built-in E2EE client (`src/e2ee`), which registers a Messenger E2EE device for the logged-in account and sends a real Signal/Noise-encrypted message. The device keys and sessions are persisted to `e2ee_device.json` in the current working directory (configurable with `e2eeDevicePath`, see [api.setOptions](#setOptions)); keep that file, deleting it registers a new E2EE device. You can also connect it ahead of time with [`api.connectE2EE`](#connectE2EE).

Attachments (images, videos, audio, files) are also sent through the E2EE client on encrypted one-to-one chats: the media is encrypted with the account's media key, uploaded to Facebook's encrypted media service and referenced from the Signal message. This is limited to one attachment per message and one-to-one chats; group E2EE needs sender keys, which this library does not implement. When the E2EE client is connected, incoming encrypted attachments are delivered as `attachments` on the message object; their media is still encrypted, so download it with [`api.downloadE2EEAttachment`](#downloadE2EEAttachment).

While the E2EE client is connected, incoming end-to-end encrypted direct messages are decrypted and delivered through `api.listen`/`api.listenMqtt` exactly like normal messages, with the peer's user ID as `threadID` and `senderID`. They are also cached locally (see [api.getThreadHistory](#getThreadHistory)). E2EE currently supports one-to-one text and attachments; reactions and group E2EE are not decrypted.

__Arguments__

* `message`: A string (for backward compatibility) or a message object as described below.
* `threadID`: A string, number, or array representing a thread. It happens to be someone's userID in the case of a one to one conversation or an array of userIDs when starting a new group chat.
* `callback(err, messageInfo)`: (Optional) A callback called when sending the message is done (either with an error or with an confirmation object). `messageInfo` contains the `threadID` where the message was sent and a `messageID`, as well as the `timestamp` of the message.
* `messageID`: (Optional) A string representing a message you want to reply.

__Message Object__:

Various types of message can be sent:
* *Regular:* set field `body` to the desired message as a string.
* *Sticker:* set a field `sticker` to the desired sticker ID.
* *File or image:* Set field `attachment` to a readable stream or an array of readable streams.
* *URL:* set a field `url` to the desired URL.
* *Emoji:* set field `emoji` to the desired emoji as a string and set field `emojiSize` with size of the emoji (`small`, `medium`, `large`)
* *Mentions:* set field `mentions` to an array of objects. Objects should have the `tag` field set to the text that should be highlighted in the mention. The object should have an `id` field, where the `id` is the user id of the person being mentioned. The instance of `tag` that is highlighted is determined through indexOf, an optional `fromIndex`
can be passed in to specify the start index to start searching for the `tag` text
in `body` (default=0). (See below for an example.)

On end-to-end encrypted one-to-one chats an attachment is sent through the E2EE client instead. Its media type is taken from the stream's path/mime type when available, otherwise sniffed from the file contents; `filename` and `mimeType` can be set explicitly on the message object to override that. `body` becomes the caption for images and videos. Only one attachment per message is supported there.

Note that a message can only be a regular message (which can be empty) and optionally one of the following: a sticker, an attachment or a url.

__Tip__: to find your own ID, you can look inside the cookies. The `userID` is under the name `c_user`.

__Example (Basic Message)__
```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    var yourID = "000000000000000";
    var msg = {body: "Hey!"};
    api.sendMessage(msg, yourID);
});
```

__Example (File upload)__
```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    // This example uploads an image called image.jpg
    var yourID = "000000000000000";
    var msg = {
        body: "Hey!",
        attachment: fs.createReadStream(__dirname + '/image.jpg')
    }
    api.sendMessage(msg, yourID);
});
```

__Example (Mention)__
```js
const login = require("facebook-chat-api");

login({email: "EMAIL", password: "PASSWORD"}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        if (message && message.body) {
            // Getting the actual sender name from ID involves calling
            // `api.getThreadInfo` and `api.getUserInfo`
            api.sendMessage({
                body: 'Hello @Sender! @Sender!',
                mentions: [{
                     tag: '@Sender',
                     id: message.senderID,
                     fromIndex: 9, // Highlight the second occurrence of @Sender
                }],
            }, message.threadID);
        }
    });
});
```

---------------------------------------

<a name="sendTypingIndicator"></a>
### api.sendTypingIndicator(threadID[, callback])

Sends a "USERNAME is typing" indicator to other members of the thread indicated by `threadID`. This indication will disappear after 30 second or when the `end` function is called. The `end` function is returned by `api.sendTypingIndicator`.

__Arguments__

* `threadID`: Group chat ID.
* `callback(err)`: A callback called when the query is done (with an error or with null).

---------------------------------------

<a name="setCommentReaction"></a>
### api.setCommentReaction(postID, commentID, reaction[, callback])

Sets (or removes) the logged-in account's reaction on a comment.

__Arguments__

* `postID`: The ID of the post the comment is on.
* `commentID`: The numeric comment ID.
* `reaction`: One of `"LIKE"`, `"LOVE"`, `"HAHA"`, `"WOW"`, `"SAD"`, `"ANGRY"`, `"CARE"`, the raw numeric `feedback_reaction_id`, or `null` to remove the current reaction.
* `callback(err, result)`: Called with `{postID, commentID, reaction}`.

---------------------------------------

<a name="setMessageReaction"></a>
### api.setMessageReaction(reaction, messageID[, callback])

Sets reaction on message

__Arguments__

* `reaction`: A string containing either an emoji, an emoji in unicode, or an emoji shortcut (see list of supported emojis below). The string can be left empty ("") in order to remove a reaction.
* `messageID`: A string representing the message ID.
* `callback(err)` - A callback called when sending the reaction is done.

__Supported Emojis__

|Emoji|Text|Unicode|Shortcuts|
|---|---|---|---|
|😍|`😍`|`\uD83D\uDE0D`|`:love:`, `:heart_eyes:`|
|😆|`😆`|`\uD83D\uDE06`|`:haha:`, `:laughing:`|
|😮|`😮`|`\uD83D\uDE2E`|`:wow:`, `:open_mouth:`|
|😢|`😢`|`\uD83D\uDE22`|`:sad:`, `:cry:`|
|😠|`😠`|`\uD83D\uDE20`|`:angry:`|
|👍|`👍`|`\uD83D\uDC4D`|`:like:`, `:thumbsup:`|
|👎|`👎`|`\uD83D\uDC4E`|`:dislike:`, `:thumbsdown:`|

---------------------------------------

<a name="setPostReaction"></a>
### api.setPostReaction(postID, reaction[, callback])

Sets (or removes) the logged-in account's reaction on a Facebook post (a post in a Facebook Group or in the feed, not a Messenger message; see [`api.setMessageReaction`](#setMessageReaction) for chats).

__Arguments__

* `postID`: The ID of the post to react to.
* `reaction`: One of `"LIKE"`, `"LOVE"`, `"HAHA"`, `"WOW"`, `"SAD"`, `"ANGRY"`, `"CARE"`, the raw numeric `feedback_reaction_id`, or `null` to remove the current reaction.
* `callback(err, result)`: Called with `{postID, reaction}`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.setPostReaction("1608281820936422", "LOVE", (err) => {
        if(err) return console.error(err);
    });
});
```

---------------------------------------

<a name="setOptions"></a>
### api.setOptions(options)

Sets various configurable options for the api.

__Arguments__

* `options` - An object containing the new values for the options that you want
  to set.  If the value for an option is unspecified, it is unchanged. The following options are possible.
    - `logLevel`: The desired logging level as determined by npmlog.  Choose
      from either `"silly"`, `"verbose"`, `"info"`, `"http"`, `"warn"`, `"error"`, or `"silent"`.
    - `selfListen`: (Default `false`) Set this to `true` if you want your api
      to receive messages from its own account.  This is to be used with
      caution, as it can result in loops (a simple echo bot will send messages
      forever).
    - `listenEvents`: (Default `false`) Will make [api.listen](#listen) also handle events (look at api.listen for more details).
    - `pageID`: (Default empty) Makes [api.listen](#listen) only receive messages through the page specified by that ID. Also makes `sendMessage` and `sendSticker` send from the page.
    - `updatePresence`: (Default `false`) Will make [api.listen](#listen) and [api.listenMqtt](#listenMqtt) also return `presence` ([api.listen](#presence) for more details).
    - `online`: (Default `true`) Keeps the account shown as online ("Active now") while [api.listenMqtt](#listenMqtt) is running, by reporting presence over Facebook's gateway the same way the web client does (`src/gatewayPresence.js`: it opens the streamcontroller socket, subscribes to `PresenceUnifiedJSON` and publishes the presence reports). Set to `false` (at login or later with `api.setOptions`) to disconnect it and let the account drop back to "Active ... ago".
    - `forceLogin`: (Default `false`) Will automatically approve of any recent logins and continue with the login process.
    - `userAgent`: (Default `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15`) The desired simulated User Agent.
	- `autoMarkDelivery`: (Default `true`) Will automatically mark new messages as delivered. Messages that arrive within a second of each other are marked in one request, so a receipt can go out up to a second after the message arrives; your own messages aren't marked. See [api.markAsDelivered](#markAsDelivered).
	- `autoMarkRead`: (Default `false`) Will automatically mark new messages as read/seen. See [api.markAsRead](#markAsRead).
	- `e2eeDevicePath`: (Default `e2ee_device.json` in the current working directory) Path of the file used to persist the E2EE device keys and Signal sessions used for encrypted one-to-one chats. Keep this file across restarts; deleting it registers a new E2EE device. See [api.connectE2EE](#connectE2EE).
	- `e2eeDeviceListCacheMs`: (Default `0`, off) How many milliseconds an end-to-end encrypted send may reuse a user's device list instead of asking the server again. Fetching it is a round trip on every encrypted send (about 0.6s), so a value like `60000` makes repeat sends to the same chat much faster. The trade-off: a device the recipient (or you) adds while its list is cached doesn't get those messages. The cached list is dropped when a send to that chat fails or the server reports a device change.
	- `e2eeFrameLog`: (Default off) Path of a JSONL file to which every decrypted incoming E2EE socket frame is appended (timestamp, parsed tag/attributes, raw hex) before parsing. Debugging aid for reverse-engineering server-side E2EE traffic; see [`examples/captureE2EE.js`](examples/captureE2EE.js).
	- `opusBitrate`: (Default `128000`) Target bitrate in bits per second for the Opus encoder used by calls with real media (`options.media`). Per-call `media.opusBitrate` wins over this. Opus caps at `510000`; the default is already transparent for speech and music.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

// Simple echo bot. This will send messages forever.

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.setOptions({
        selfListen: true,
        logLevel: "silent"
    });

    api.listen((err, message) => {
        if(err) return console.error(err);

        // Ignore empty messages (photos etc.)
        if (typeof message.body === "string") {
            api.sendMessage(message.body, message.threadID);
        }
    });
});
```

---------------------------------------

<a name="setTitle"></a>
### api.setTitle(newTitle, threadID[, callback])

Sets the title of the group chat with thread id `threadID` to `newTitle`.

Note: This will not work if the thread id corresponds to a single-user chat or if the bot is not in the group chat.

__Arguments__

* `newTitle`: A string representing the new title.
* `threadID`: A string or number representing a thread. It happens to be someone's userID in the case of a one to one conversation.
* `callback(err, obj)` - A callback called when sending the message is done (either with an error or with an confirmation object). `obj` contains only the threadID where the message was sent.

---------------------------------------

<a name="unpinGroupPost"></a>
### api.unpinGroupPost(postID[, options][, callback])

Removes a post from the top of a Facebook Group's feed (the counterpart of [`api.pinGroupPost`](#pinGroupPost)).

__Arguments__

* `postID`: The ID of the post.
* `options`: Optional; `authorID` is the post author's user ID (defaults to the logged-in account); see [`api.deleteGroupPost`](#deleteGroupPost).
* `callback(err, result)`: Called with `{postID, pinned: false}`.

---------------------------------------

<a name="unsendMessage"></a>
### api.unsendMessage(messageID[, callback])

Revokes a message from anyone that could see that message with `messageID`

Note: This will only work if the message is sent by you and was sent less than 10 minutes ago.

__Arguments__

* `messageID`: Message ID you want to unsend.
* `callback(err)`: A callback called when the query is done (with an error or with null).

---------------------------------------

<a name="updateGroup"></a>
### api.updateGroup(groupID, settings[, callback])

Updates a Facebook Group's name and/or description. Requires admin rights; pass only the fields you want to change.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `settings`: Object with optional `name` and `description` strings.
* `callback(err, result)`: Called with `{groupID, name, description}` (only the changed fields are set).

__Example__

```js
api.updateGroup("1608281640936440", {description: "Group about headphones"}, (err) => {
    if(err) return console.error(err);
});
```

---------------------------------------

<a name="updateGroupDiscoverability"></a>
### api.updateGroupDiscoverability(groupID, discoverability[, callback])

Controls whether a Facebook Group can be found in search: `"ANYONE"` (visible) or `"MEMBERS_ONLY"` (hidden). Requires admin rights. Facebook only allows changing a group's *privacy* (public/private) once the group meets its eligibility rules, which is why that part isn't exposed here.

__Arguments__

* `groupID`: The ID of the Facebook Group.
* `discoverability`: `"ANYONE"` or `"MEMBERS_ONLY"`.
* `callback(err, result)`: Called with `{groupID, discoverability}`.

__Example__

```js
api.updateGroupDiscoverability("1815304706561728", "MEMBERS_ONLY", (err) => {
    if(err) return console.error(err);
});
```

---------------------------------------
