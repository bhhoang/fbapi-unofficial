Note: This repo is in maintenance mode. Bug fixes will be happily merged if they are submitted in simple or well-explained PRs (thank you to all the contributors over the years!), but new features will usually not be merged (because all features eventually break and increase the maintenance cost). I don't have enough time to better support this project and believe the approach is ok for one-off scripts or fun projects but fundamentally too unstable for any serious application. Any change by Facebook can break the api overnight and that's assuming the api can remain compliant enough not to get blocked. Unfortunately we will need to wait and hope that they decide to build a powerful enough bot system to support all these usecases.

# Unofficial Facebook Chat API
<a href="https://www.npmjs.com/package/facebook-chat-api"><img alt="npm version" src="https://img.shields.io/npm/v/facebook-chat-api.svg?style=flat-square"></a>
<a href="https://www.npmjs.com/package/facebook-chat-api"><img src="https://img.shields.io/npm/dm/facebook-chat-api.svg?style=flat-square" alt="npm downloads"></a>
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

Facebook now has an official API for chat bots [here](https://developers.facebook.com/docs/messenger-platform).

This API is the only way to automate chat functionalities on a user account. We do this by emulating the browser. This means doing the exact same GET/POST requests and tricking Facebook into thinking we're accessing the website normally. Because we're doing it this way, this API won't work with an auth token but requires the credentials of a Facebook account.

_Disclaimer_: We are not responsible if your account gets banned for spammy activities such as sending lots of messages to people you don't know, sending messages very quickly, sending spammy looking URLs, logging in and out very quickly... Be responsible Facebook citizens.

See [below](#projects-using-this-api) for projects using this API.

See the [full changelog](/CHANGELOG.md) for release details.

## Install
If you just want to use facebook-chat-api, you should use this command:
```bash
npm install facebook-chat-api
```
It will download facebook-chat-api from NPM repositories

### Bleeding edge
If you want to use bleeding edge (directly from github) to test new features or submit bug report, this is the command for you:
```bash
npm install Schmavery/facebook-chat-api
```

## Testing your bots
If you want to test your bots without creating another account on Facebook, you can use [Facebook Whitehat Accounts](https://www.facebook.com/whitehat/accounts/).

## Example Usage
```javascript
const login = require("facebook-chat-api");

// Create simple echo bot
login({email: "FB_EMAIL", password: "FB_PASSWORD"}, (err, api) => {
    if(err) return console.error(err);

    api.listen((err, message) => {
        api.sendMessage(message.body, message.threadID);
    });
});
```

Result:

<img width="517" alt="screen shot 2016-11-04 at 14 36 00" src="https://cloud.githubusercontent.com/assets/4534692/20023545/f8c24130-a29d-11e6-9ef7-47568bdbc1f2.png">


## Documentation

* [`login`](DOCS.md#login)
* [`api.acceptCall`](DOCS.md#acceptCall)
* [`api.addUserToGroup`](DOCS.md#addUserToGroup)
* [`api.approveJoinRequest`](DOCS.md#approveJoinRequest)
* [`api.blockGroupMember`](DOCS.md#blockGroupMember)
* [`api.call`](DOCS.md#call) (with real two-way audio through `options.media`)
* [`api.changeAdminStatus`](DOCS.md#changeAdminStatus)
* [`api.changeArchivedStatus`](DOCS.md#changeArchivedStatus)
* [`api.changeBlockedStatus`](DOCS.md#changeBlockedStatus)
* [`api.changeGroupImage`](DOCS.md#changeGroupImage)
* [`api.changeNickname`](DOCS.md#changeNickname)
* [`api.changeThreadColor`](DOCS.md#changeThreadColor)
* [`api.changeThreadEmoji`](DOCS.md#changeThreadEmoji)
* [`api.connectCalls`](DOCS.md#connectCalls)
* [`api.connectE2EE`](DOCS.md#connectE2EE)
* [`api.createComment`](DOCS.md#createComment)
* [`api.createGroup`](DOCS.md#createGroup)
* [`api.createGroupPost`](DOCS.md#createGroupPost)
* [`api.createPoll`](DOCS.md#createPoll)
* [`api.declineCall`](DOCS.md#declineCall)
* [`api.declineJoinRequest`](DOCS.md#declineJoinRequest)
* [`api.deleteComment`](DOCS.md#deleteComment)
* [`api.deleteGroupPost`](DOCS.md#deleteGroupPost)
* [`api.deleteMessage`](DOCS.md#deleteMessage)
* [`api.deleteThread`](DOCS.md#deleteThread)
* [`api.downloadE2EEAttachment`](DOCS.md#downloadE2EEAttachment)
* [`api.editComment`](DOCS.md#editComment)
* [`api.editGroupPost`](DOCS.md#editGroupPost)
* [`api.endCall`](DOCS.md#endCall)
* [`api.followGroup`](DOCS.md#followGroup)
* [`api.forwardAttachment`](DOCS.md#forwardAttachment)
* [`api.getAppState`](DOCS.md#getAppState)
* [`api.getCalls`](DOCS.md#getCalls)
* [`api.getCurrentUserID`](DOCS.md#getCurrentUserID)
* [`api.getFeed`](DOCS.md#getFeed)
* [`api.getFriendsList`](DOCS.md#getFriendsList)
* [`api.getGroupEvents`](DOCS.md#getGroupEvents)
* [`api.getGroupFiles`](DOCS.md#getGroupFiles)
* [`api.getGroupInfo`](DOCS.md#getGroupInfo)
* [`api.getGroupMedia`](DOCS.md#getGroupMedia)
* [`api.getGroupMembers`](DOCS.md#getGroupMembers)
* [`api.getGroupPosts`](DOCS.md#getGroupPosts)
* [`api.getGroupRules`](DOCS.md#getGroupRules)
* [`api.getPostComments`](DOCS.md#getPostComments)
* [`api.getPostReactions`](DOCS.md#getPostReactions)
* [`api.getThreadHistory`](DOCS.md#getThreadHistory)
* [`api.getThreadInfo`](DOCS.md#getThreadInfo)
* [`api.getThreadList`](DOCS.md#getThreadList)
* [`api.getThreadPictures`](DOCS.md#getThreadPictures)
* [`api.getUserID`](DOCS.md#getUserID)
* [`api.getUserInfo`](DOCS.md#getUserInfo)
* [`api.handleMessageRequest`](DOCS.md#handleMessageRequest)
* [`api.inviteToGroup`](DOCS.md#inviteToGroup)
* [`api.joinGroup`](DOCS.md#joinGroup)
* [`api.leaveGroup`](DOCS.md#leaveGroup)
* [`api.likePost`](DOCS.md#likePost)
* [`api.listen`](DOCS.md#listen)
* [`api.listenMqtt`](DOCS.md#listenMqtt)
* [`api.logout`](DOCS.md#logout)
* [`api.markAsRead`](DOCS.md#markAsRead)
* [`api.markAsReadAll`](DOCS.md#markAsReadAll)
* [`api.markGroupVisited`](DOCS.md#markGroupVisited)
* [`api.muteThread`](DOCS.md#muteThread)
* [`api.pinGroupPost`](DOCS.md#pinGroupPost)
* [`api.removeGroupMember`](DOCS.md#removeGroupMember)
* [`api.removeUserFromGroup`](DOCS.md#removeUserFromGroup)
* [`api.resolvePhotoUrl`](DOCS.md#resolvePhotoUrl)
* [`api.restoreE2EEBackup`](DOCS.md#restoreE2EEBackup)
* [`api.searchForThread`](DOCS.md#searchForThread)
* [`api.searchGroupMembers`](DOCS.md#searchGroupMembers)
* [`api.searchMessages`](DOCS.md#searchMessages)
* [`api.searchGroupPosts`](DOCS.md#searchGroupPosts)
* [`api.sendMessage`](DOCS.md#sendMessage)
* [`api.sendTypingIndicator`](DOCS.md#sendTypingIndicator)
* [`api.setCommentReaction`](DOCS.md#setCommentReaction)
* [`api.setMessageReaction`](DOCS.md#setMessageReaction)
* [`api.setOptions`](DOCS.md#setOptions)
* [`api.setPostReaction`](DOCS.md#setPostReaction)
* [`api.setTitle`](DOCS.md#setTitle)
* [`api.threadColors`](DOCS.md#threadColors)
* [`api.unfollowGroup`](DOCS.md#unfollowGroup)
* [`api.unpinGroupPost`](DOCS.md#unpinGroupPost)
* [`api.unsendMessage`](DOCS.md#unsendMessage)
* [`api.updateGroup`](DOCS.md#updateGroup)
* [`api.updateGroupDiscoverability`](DOCS.md#updateGroupDiscoverability)

## Main Functionality

### Sending a message
#### api.sendMessage(message, threadID[, callback][, messageID])

Various types of message can be sent:
* *Regular:* set field `body` to the desired message as a string.
* *Sticker:* set a field `sticker` to the desired sticker ID.
* *File or image:* Set field `attachment` to a readable stream or an array of readable streams.
* *URL:* set a field `url` to the desired URL.
* *Emoji:* set field `emoji` to the desired emoji as a string and set field `emojiSize` with size of the emoji (`small`, `medium`, `large`)

Note that a message can only be a regular message (which can be empty) and optionally one of the following: a sticker, an attachment or a url.

__Tip__: to find your own ID, you can look inside the cookies. The `userID` is under the name `c_user`.

__Encrypted one-to-one chats__: Facebook now end-to-end encrypts direct chats by default. `api.sendMessage` handles those automatically: after `api.listenMqtt` is connected, a plain text message to an encrypted chat is sent through the built-in E2EE (Signal + Noise) client instead of being rejected. Attachments (images, videos, audio, files) are also encrypted and uploaded through that client, one attachment per message. Incoming encrypted direct messages, including attachments, are decrypted and delivered to your `api.listenMqtt` callback like normal messages, and are cached for `api.getThreadHistory`; encrypted attachment media is downloaded and decrypted with `api.downloadE2EEAttachment`. The first encrypted send (or an explicit `api.connectE2EE`) registers this library as an E2EE device for your account and saves its keys to `e2ee_device.json` in the working directory (change it with `api.setOptions({ e2eeDevicePath: "..." })`) — keep that file between runs. One-to-one text and attachments only; group E2EE is not supported. See [`api.connectE2EE`](DOCS.md#connectE2EE).

__Example (Basic Message)__
```js
const login = require("facebook-chat-api");

login({email: "FB_EMAIL", password: "FB_PASSWORD"}, (err, api) => {
    if(err) return console.error(err);

    var yourID = "000000000000000";
    var msg = "Hey!";
    api.sendMessage(msg, yourID);
});
```

__Example (File upload)__
```js
const login = require("facebook-chat-api");

login({email: "FB_EMAIL", password: "FB_PASSWORD"}, (err, api) => {
    if(err) return console.error(err);

    // Note this example uploads an image called image.jpg
    var yourID = "000000000000000";
    var msg = {
        body: "Hey!",
        attachment: fs.createReadStream(__dirname + '/image.jpg')
    }
    api.sendMessage(msg, yourID);
});
```

------------------------------------
### Logging in with an appState (recommended)

> **appState is still the most reliable login method.** Email/password (or
> user ID) login is supported: without 2FA it replays the current headerless
> Web login (a GraphQL mutation with the password encrypted against the page's
> public key); with a `twoFactorSecret` it uses Facebook's mobile app auth
> endpoint, which reports the two-factor challenge explicitly and accepts the
> generated TOTP code, so a 2FA login can complete programmatically. The web
> form alone may trigger an interactive security check (Arkose CAPTCHA) before
> accepting a 2FA code, which needs a browser — in that case the login fails
> with `twoFactorRequired: true`. See [`login`](DOCS.md#login) for details.

An appState is an array of your `facebook.com` cookies. Because you export it
from a browser where you've already logged in (and cleared any 2FA/checkpoint),
appState login skips the password/2FA steps entirely.

You can also pass `appState` **together with** `email`/`password` to refresh the
session on the same browser device — the device cookies are reused so Facebook
recognizes the browser instead of flagging a new login. See
[`login`](DOCS.md#login).

**1. Export your cookies to `appstate.json`.** Log into facebook.com in a
browser, then use a cookie-export extension to save your facebook.com cookies as
a JSON **array**. Both cookie shapes are accepted: objects with `key` (what
`api.getAppState()` produces) or with `name` (what most browser exporters
produce).

**2. Log in with it:**

```js
const fs = require("fs");
const login = require("facebook-chat-api");

login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err.error || err);

    // Save a refreshed appState so your session stays current for reuse.
    fs.writeFileSync('appstate.json', JSON.stringify(api.getAppState(), null, 2));

    console.log("Logged in as " + api.getCurrentUserID());
});
```

A ready-to-run version (with self-refresh and setup notes) is in
[`examples/loginWithAppState.js`](examples/loginWithAppState.js):

```
node examples/loginWithAppState.js [path/to/appstate.json]
```

The library validates the appState before using it and gives a clear error if
it isn't an array, is missing required cookie fields, or is missing the
`c_user` login cookie. An expired session surfaces as `"Not logged in."` —
re-export a fresh appState from your browser when that happens.

------------------------------------

### Listening to a chat
#### api.listen(callback)

Listen watches for messages sent in a chat. By default this won't receive events (joining/leaving a chat, title change etc…) but it can be activated with `api.setOptions({listenEvents: true})`. This will by default ignore messages sent by the current account, you can enable listening to your own messages with `api.setOptions({selfListen: true})`.

__Example__

```js
const fs = require("fs");
const login = require("facebook-chat-api");

// Simple echo bot. It will repeat everything that you say.
// Will stop when you say '/stop'
login({appState: JSON.parse(fs.readFileSync('appstate.json', 'utf8'))}, (err, api) => {
    if(err) return console.error(err);

    api.setOptions({listenEvents: true});

    var stopListening = api.listen((err, event) => {
        if(err) return console.error(err);

        api.markAsRead(event.threadID, (err) => {
            if(err) console.error(err);
        });

        switch(event.type) {
            case "message":
                if(event.body === '/stop') {
                    api.sendMessage("Goodbye…", event.threadID);
                    return stopListening();
                }
                api.sendMessage("TEST BOT: " + event.body, event.threadID);
                break;
            case "event":
                console.log(event);
                break;
        }
    });
});
```

## FAQS

1. How do I run tests?
> For tests, create a `test-config.json` file that resembles `example-config.json` and put it in the `test` directory. From the root >directory, run `npm test`.

2. Why doesn't `sendMessage` always work when I'm logged in as a page?
> Pages can't start conversations with users directly; this is to prevent pages from spamming users.

3. What do I do when `login` doesn't work?
> First check that you can login to Facebook using the website. If login approvals are enabled, you might be logging in incorrectly. For how to handle login approvals, read our docs on [`login`](DOCS.md#login).

4. How can I avoid logging in every time?  Can I log into a previous session?
> We support caching everything relevant for you to bypass login. `api.getAppState()` returns an object that you can save and pass into login as `{appState: mySavedAppState}` instead of the credentials object.  If this fails, your session has expired.

5. Do you support sending messages as a page?
> Yes, set the pageID option on login (this doesn't work if you set it using api.setOptions, it affects the login process).
> ```js
> login(credentials, {pageID: "000000000000000"}, (err, api) => { … }
> ```

6. I'm getting some crazy weird syntax error like `SyntaxError: Unexpected token [`!!!
> Please try to update your version of node.js before submitting an issue of this nature.  We like to use new language features.

7. I don't want all of these logging messages!
> You can use `api.setOptions` to silence the logging. You get the `api` object from `login` (see example above). Do
> ```js
> api.setOptions({
>     logLevel: "silent"
> });
> ```

## Projects using this API

- [Messer](https://github.com/mjkaufer/Messer) - Command-line messaging for Facebook Messenger
- [messen](https://github.com/tomquirk/messen) - Rapidly build Facebook Messenger apps in Node.js
- [Concierge](https://github.com/concierge/Concierge) - Concierge is a highly modular, easily extensible general purpose chat bot with a built in package manager
- [Marc Zuckerbot](https://github.com/bsansouci/marc-zuckerbot) - Facebook chat bot
- [Marc Thuckerbot](https://github.com/bsansouci/lisp-bot) - Programmable lisp bot
- [MarkovsInequality](https://github.com/logicx24/MarkovsInequality) - Extensible chat bot adding useful functions to Facebook Messenger
- [AllanBot](https://github.com/AllanWang/AllanBot-Public) - Extensive module that combines the facebook api with firebase to create numerous functions; no coding experience is required to implement this.
- [Larry Pudding Dog Bot](https://github.com/Larry850806/facebook-chat-bot) - A facebook bot you can easily customize the response
- [fbash](https://github.com/avikj/fbash) - Run commands on your computer's terminal over Facebook Messenger
- [Klink](https://github.com/KeNt178/klink) - This Chrome extension will 1-click share the link of your active tab over Facebook Messenger
- [Botyo](https://github.com/ivkos/botyo) - Modular bot designed for group chat rooms on Facebook
- [matrix-puppet-facebook](https://github.com/matrix-hacks/matrix-puppet-facebook) - A facebook bridge for [matrix](https://matrix.org)
- [facebot](https://github.com/Weetbix/facebot) - A facebook bridge for Slack.
- [Botium](https://github.com/codeforequity-at/botium-core) - The Selenium for Chatbots
- [Messenger-CLI](https://github.com/AstroCB/Messenger-CLI) - A command-line interface for sending and receiving messages through Facebook Messenger.
- [AssumeZero-Bot](https://github.com/AstroCB/AssumeZero-Bot) – A highly customizable Facebook Messenger bot for group chats.
- [Miscord](https://github.com/Bjornskjald/miscord) - An easy-to-use Facebook bridge for Discord.
- [chat-bridge](https://github.com/rexx0520/chat-bridge) - A Messenger, Telegram and IRC chat bridge.
- [messenger-auto-reply](https://gitlab.com/theSander/messenger-auto-reply) - An auto-reply service for Messenger.
- [BotCore](https://github.com/AstroCB/BotCore) – A collection of tools for writing and managing Facebook Messenger bots.
- [mnotify](https://github.com/AstroCB/mnotify) – A command-line utility for sending alerts and notifications through Facebook Messenger.
