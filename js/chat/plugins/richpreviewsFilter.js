/**
 * A simple Rich Preview plugin, which is supposed to listen for when sending messages and preparing URL previews,
 * so that when the message gets confirmed an update/edit would be send with message type = CONTAINS_META and
 * META_TYPE = RICH_PREVIEW.
 *
 * @param megaChat
 * @returns {RichpreviewsFilter}
 * @constructor
 */
var RichpreviewsFilter = function(megaChat) {
    "use strict";
    var self = this;

    megaChat.on("onBeforeSendMessage", function(e, eventData) {
        self.processMessage(e, eventData);
    });

    megaChat
        .rebind('onRoomInitialized.richpreviewsFilter', function(e, megaRoom) {
            $(megaRoom).rebind('onPendingMessageConfirmed.richpreviewsFilter', function(e, msgObj) {
                self.onPendingMessageConfirmed(megaRoom, msgObj);
                msgObj.confirmed = true;
            });
            $(megaRoom).rebind('onMessageUpdating.richpreviewsFilter', function(e, msgObj) {
                var msgId = msgObj.messageId;
                RichpreviewsFilter._messageUpdating[msgObj.chatRoom.roomId + "_" + msgId] = true;
            });
            $(megaRoom).rebind('onMessageUpdateDecrypted.richpreviewsFilter', function(e, msgObj) {
                [
                    msgObj.chatRoom.roomId + "_" + msgObj.messageId,
                    msgObj.chatRoom.roomId + "_" + msgObj.pendingMessageId
                ].forEach(function(k) {
                    if (RichpreviewsFilter._waitConfirm[k] && (msgObj.deleted || msgObj.textContents === "")) {
                        RichpreviewsFilter._canceled[k] = true;
                        delete RichpreviewsFilter._waitConfirm[k];
                    }
                    else if (RichpreviewsFilter._messageUpdating[k]) {
                        delete RichpreviewsFilter._messageUpdating[k];
                        if (msgObj) {
                            self.processMessage(e, msgObj, false, true);
                        }
                    }
                });
            });
        });

    megaChat.rebind("onInit.richpreviewsFilter", function() {
        if (anonymouschat === true) {
            return;
        }
        RichpreviewsFilter.syncFromAttribute();
        mBroadcaster.addListener("attr:rp", function() {
            RichpreviewsFilter.syncFromAttribute();
        });
    });
    return this;
};

/**
 * Used to store the state of the rich previews confirmation
 * @type {Number|Boolean}
 */
RichpreviewsFilter.previewGenerationConfirmation = -1;


/**
 * Internal cache.
 * @type {{}}
 * @private
 */
RichpreviewsFilter._waitConfirm = {};

/**
 * Internal cache.
 * @type {{}}
 * @private
 */
RichpreviewsFilter._requests = {};

/**
 * Internal cache.
 * @type {{}}
 * @private
 */
RichpreviewsFilter._canceled = {};

/**
 * Internal cache.
 * @type {{}}
 * @private
 */
RichpreviewsFilter._messageUpdating = {};

/**
 * Regular expression for reserved IP addresses
 *
 * http://localhost/
 * http://0.0.0.0/ - http://0.255.255.255/
 * http://10.0.0.0/ - http://10.255.255.255/
 * http://100.64.0.0/ - http://100.127.255.255/
 * http://127.0.0.0/ - http://127.255.255.255/
 * http://169.254.0.0/ - http://169.254.255.255/
 * http://172.16.0.0/ - http://172.31.255.255/
 * http://192.0.0.0/ - http://192.0.0.255/
 * http://192.0.2.0/ - http://192.0.2.255/
 * http://192.88.99.0/ - http://192.88.99.255/
 * http://192.168.0.0/ - http://192.168.255.255/
 * http://198.18.0.0/ - http://198.19.255.255/
 * http://198.51.100.0/ - http://198.51.100.255/
 * http://203.0.113.0/ - http://203.0.113.255/
 * http://224.0.0.0/ - http://239.255.255.255/
 * http://240.0.0.0/ - http://255.255.255.255/
 *
 * @see https://en.wikipedia.org/wiki/Reserved_IP_addresses
 * @see RichpreviewsFilter.prototype.processMessage
 * @type {RegExp}
 * @private
 */

RichpreviewsFilter._RFC_REGEXP = new RegExp(
    '(^127\\.)|(^10\\.)|(^172\\.1[6-9]\\.)|(^172\\.2\\d\\.)|(^172\\.3[01]\\.)|(^192\\.0\\.)|(^192\\.88\\.)|' +
    '(^192\\.168\\.)|(^169\\.254\\.)|(^100\\.)|(^255\\.255\\.)|(^203\\.)|(^0\\.)|(^240\\.0)|(^224\\.0)|(^198\\.)|' +
    '(^239\\.255)|localhost',
    'mg'
);


/**
 * Main API for retrieving (and in-memory caching) previews for specific URL.
 *
 * @param url
 * @returns {*}
 */
RichpreviewsFilter.retrievePreview = function(url) {
    "use strict";

    if (!RichpreviewsFilter._requests[url]) {

        RichpreviewsFilter._requests[url] = asyncApiReq({"a":"erlsd", "url": url});
    }

    return RichpreviewsFilter._requests[url];
};

/**
 * Internally used to process outgoing messages.
 *
 * @private
 * @param e {Object}
 * @param eventData {Message}
 * @param [forced] {Boolean}
 * @param [isEdit] {Boolean}
 */
RichpreviewsFilter.prototype.processMessage = function(e, eventData, forced, isEdit) {
    "use strict";

    var self = this;

    // use the HTML version of the message if such exists (the HTML version should be generated by hooks/filters on the
    // client side.
    var textContents = eventData.textContents;

    if (!textContents) {
        // this shouldn't happen, but just in case...
        return;
    }

    if (RichpreviewsFilter.previewGenerationConfirmation === false) {
        return;
    }

    if (isEdit) {
        textContents = megaChat.plugins.btRtfFilter.escapeAndProcessMessage(
            e,
            eventData,
            ["messageHtml", "textContents"],
            "messageHtml",
            true
        );

        textContents = megaChat.plugins.rtfFilter.processStripRtfFromMessage(textContents);
    }

    var haveLinks = false;

    var key = eventData.chatRoom.roomId + "_" + (
        eventData.messageId ? eventData.messageId : eventData.pendingMessageId
    );

    var urls = [];

    var shouldAppendToMeta = false;
    if (!eventData.meta) {
        eventData.meta = {};
        shouldAppendToMeta = true;
    }
    if (!eventData.meta.extra) {
        eventData.meta.extra = [];
        shouldAppendToMeta = true;
    }

    Autolinker.link(textContents, {
        className: 'chatlink',
        truncate: false,
        newWindow: true,
        stripPrefix: true,
        stripTrailingSlash: false,
        twitter: false,
        replaceFn : function(match) {
            switch (match.getType()) {
                case 'url' :
                    var link = match.getUrl();

                    if (LinkInfoHelper.isMegaLink(link)) {
                        // skip MEGA links.
                        return true;
                    }

                    var anchorText = match.getAnchorText(); // stripped link, e.g. http://172.16.0.0 -> 172.16.0.0
                    var IS_RFC = !!anchorText.match(RichpreviewsFilter._RFC_REGEXP);
                    if (IS_RFC) {
                        // no previews for reserved IP addresses
                        return false;
                    }

                    if (link.indexOf("http://") !== 0 && link.indexOf("https://") !== 0) {
                        return false;
                    }

                    if (urls.length < 1) {
                        eventData.metaType = Message.MESSAGE_META_TYPE.RICH_PREVIEW;

                        if (shouldAppendToMeta) {
                            eventData.meta.extra.push({'url': link});
                        }
                        urls.push(link);

                        haveLinks = true;
                    }
                    return true;  // let Autolinker perform its normal anchor tag replacement
                default:
                    return true;
            }
        }
    });


    if (haveLinks && (forced || RichpreviewsFilter.previewGenerationConfirmation === true)) {
        eventData.meta['isLoading'] = unixtime();
        RichpreviewsFilter._waitConfirm[key] = urls;

        if (
            eventData.getState && (
                eventData.getState() === Message.STATE.SENT ||
                (eventData.getState() === Message.STATE.DELIVERED && eventData.source === undefined)
            )
        ) {
            self.onPendingMessageConfirmed(eventData.chatRoom, eventData);
        }
    }
    else if (haveLinks && RichpreviewsFilter.previewGenerationConfirmation === -1) {
        eventData.meta['requiresConfirmation'] = true;
    }
    if (haveLinks && eventData.trackDataChange) {
        eventData.trackDataChange();
    }
};

/**
 * Once a message's preview is retrieved - this method would do a msg update with the actual message's preview
 *
 * @param chatRoom {ChatRoom}
 * @param msgObj {Message}
 * @param responses {Array}
 * @param isRetry {Boolean}
 * @private
 */
RichpreviewsFilter._updateMessageToPreview = function(chatRoom, msgObj, responses, isRetry) {
    "use strict";

    if (msgObj.deleted) {
        return;
    }

    if (!chatRoom.messagesBuff.getMessageById(msgObj.messageId)) {
        // was deleted/truncated/removed, while waiting for the preview.
        if (isRetry) {
            if (d) {
                console.error("stop retry.", msgObj.messageId);
            }
            return;
        }
        else {
            setTimeout(function() {
                // try again a bit later, since this message may be still not "confirmed" in the messagesBuff,
                // because of throttling
                RichpreviewsFilter._updateMessageToPreview(chatRoom, msgObj, responses, true);
            }, 500);
        }
        return;
    }

    var keys = [
        chatRoom.roomId + "_" + msgObj.pendingMessageId,
        chatRoom.roomId + "_" + msgObj.messageId,
    ];
    var foundCanceled = false;

    keys.forEach(function(key) {
        if (RichpreviewsFilter._canceled[key]) {
            // halt if canceled.
            delete RichpreviewsFilter._canceled[key];
            foundCanceled = true;
            return;
        }
    });

    if (foundCanceled === true) {
        return;
    }


    var meta = {
        'textMessage': msgObj.textContents,
        'extra': []
    };

    var foundValidResponses = false;
    responses.forEach(function(response) {
        if (response && response.result) {
            foundValidResponses = true;
            var entry = {
                't': response.result.t,
                'd': response.result.d,
                'i': response.result.i,
                'ic': response.result.ic,
                'url': response.result.url
            };

            meta.extra.push(entry);
        }
    });

    if (foundValidResponses && meta.extra.length > 0) {
        var messageContents = (
            Message.MANAGEMENT_MESSAGE_TYPES.MANAGEMENT +
            Message.MANAGEMENT_MESSAGE_TYPES.CONTAINS_META + Message.MESSAGE_META_TYPE.RICH_PREVIEW +
            JSON.stringify(meta)
        );

        chatRoom.megaChat.plugins.chatdIntegration.updateMessage(
            chatRoom,
            msgObj.orderValue,
            messageContents
        );
    }
    else {
        msgObj.meta = {};
        delete msgObj.metaType;
        msgObj.trackDataChange();
    }
};


/**
 * Called internally when the pending message gets converted to a confirmed one.
 * This fn starts the process of retrieving URL previews.
 *
 * @private
 * @param chatRoom {ChatRoom}
 * @param msgObj {Message}
 * @returns {MegaPromise}
 */
RichpreviewsFilter.prototype.onPendingMessageConfirmed = function(chatRoom, msgObj) {
    "use strict";

    if (msgObj.textContents && msgObj.textContents.charCodeAt && msgObj.textContents.charCodeAt(0) === 0) {
        // not a text message.
        return;
    }
    var keys = [
        chatRoom.roomId + "_" + msgObj.pendingMessageId,
        chatRoom.roomId + "_" + msgObj.messageId
    ];

    var retrievePromises = [];
    var responses = [];

    var urlLoaded = function (response) {
        responses.push(response);
    };
    var urlFailedToLoad = function () {
        if (d) {
            console.error("rich preview fail", arguments);
        }
    };

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];

        if (RichpreviewsFilter._waitConfirm[key]) {
            var urls = RichpreviewsFilter._waitConfirm[key];
            for (var x = 0; x < urls.length; x++) {
                retrievePromises.push(
                    RichpreviewsFilter.retrievePreview(urls[x])
                        .done(urlLoaded)
                        .fail(urlFailedToLoad)
                );
                delete RichpreviewsFilter._waitConfirm[key];
            }

            if (key === chatRoom.roomId + "_" + msgObj.pendingMessageId) {
                // was stored as a pending msgid, so now we need to mark the confirmed as "waiting for preview".

                RichpreviewsFilter._waitConfirm[chatRoom.roomId + "_" + msgObj.messageId] = urls;
                delete RichpreviewsFilter._waitConfirm[key];

            }
            break;
        }
    }

    return retrievePromises.length > 0 ?
        MegaPromise.allDone(retrievePromises)
            .done(function() {
                RichpreviewsFilter._updateMessageToPreview(chatRoom, msgObj, responses, false);
            })
            .always(function() {
                for (var i = 0; i < keys.length; i++) {
                    delete RichpreviewsFilter._waitConfirm[keys[i]];
                }
            }) :
        MegaPromise.reject();

};


/**
 * Called by the UI to cancel loading of a message's previews
 *
 * @param chatRoom {ChatRoom}
 * @param msgObj {Message}
 */
RichpreviewsFilter.prototype.cancelLoading = function(chatRoom, msgObj) {
    "use strict";

    var key = chatRoom.roomId + "_" + msgObj.pendingMessageId;


    if (RichpreviewsFilter._waitConfirm[key]) {
        delete RichpreviewsFilter._waitConfirm[key];
    }

    var url = msgObj.meta ? msgObj.meta.url : false;
    if (url) {
        RichpreviewsFilter._canceled[key] = true;
        if (RichpreviewsFilter._requests[url]) {
            RichpreviewsFilter._requests[url].always(function () {
                setTimeout(function () {
                    // cleanup
                    delete RichpreviewsFilter._canceled[url];
                }, 1500);
            });
        }
        if (msgObj.meta && msgObj.meta.isLoading) {
            msgObj.meta.isLoading = false;
            delete msgObj.metaType;
            msgObj.trackDataChange();
        }
    }
};

/**
 * Called by the UI to remove a preview/revert the preview message back to text.
 *
 * @param chatRoom {ChatRoom}
 * @param msgObj {Message}
 */
RichpreviewsFilter.prototype.revertToText = function(chatRoom, msgObj) {
    "use strict";

    this.cancelLoading(chatRoom, msgObj);

    if (msgObj.meta && !msgObj.meta.isLoading && msgObj.isEditable()) {
        var textMessage = msgObj.meta.textMessage ? msgObj.meta.textMessage : msgObj.textContents;
        if (textMessage) {
            chatRoom.megaChat.plugins.chatdIntegration.updateMessage(
                chatRoom,
                msgObj.orderValue,
                textMessage
            );
        }
    }
};

/**
 * Called by the UI to generate a preview for a specific message
 *
 * @param messageObj {Message}
 */
RichpreviewsFilter.prototype.insertPreview = function(messageObj) {
    "use strict";

    var self = this;
    self.processMessage(false, messageObj, true);
};

/**
 * Called on megaChat init and on *!rp update (via the uaPacketHandlers) to sync the previewGenerationConfirmation,
 * confirmationCount and UI (if on the settings page) with the newly updated attribute data
 */
RichpreviewsFilter.syncFromAttribute = function() {
    "use strict";

    // retrieve privacy dialog confirmation.
    mega.attr.get(u_handle, "rp", false, true)
        .done(function(r) {
            if (r.num === "1") {
                RichpreviewsFilter.previewGenerationConfirmation = true;
            }
            else if (r.num === "0") {
                RichpreviewsFilter.previewGenerationConfirmation = false;
            }
            else {
                RichpreviewsFilter.previewGenerationConfirmation = -1;
            }

            RichpreviewsFilter.confirmationCount = parseInt(r.c, 10) || 0;
        })
        .fail(function() {
            RichpreviewsFilter.previewGenerationConfirmation = -1;
            RichpreviewsFilter.confirmationCount = 0;
        })
        .always(function() {
            if (M.currentdirid && M.currentdirid.indexOf("account") > -1) {
                // below if statment is to exlude URLs having user-management (Business)
                if (M.currentdirid.indexOf('user-management') === -1) {
                    accountUI();
                }
            }
        });
};

/**
 * Public api, to be used to confirm the rich preview confirmation dialog
 */
RichpreviewsFilter.confirmationDoConfirm = function() {
    "use strict";

    RichpreviewsFilter.previewGenerationConfirmation = true;
    mega.attr.set("rp", {num: "1", c: "0"}, false, true);
};

/**
 * Public api, to be used to mark as 'not now' the rich preview confirmation dialog
 */
RichpreviewsFilter.confirmationDoNotNow = function() {
    "use strict";

    RichpreviewsFilter.previewGenerationConfirmation = -1;
    RichpreviewsFilter.confirmationCount++;
    mega.attr.set("rp", {c: String(RichpreviewsFilter.confirmationCount)}, false, true);
};

/**
 * Public api, to be used to mark as 'never' the rich preview confirmation dialog
 */
RichpreviewsFilter.confirmationDoNever = function() {
    "use strict";

    RichpreviewsFilter.previewGenerationConfirmation = false;
    RichpreviewsFilter.confirmationCount = 0;
    mega.attr.set("rp", {num: "0", c: "0"}, false, true);
};

/**
 * Public api, to reset the rich preview confirmation dialog
 */
RichpreviewsFilter.confirmationDoReset = function() {
    "use strict";

    RichpreviewsFilter.previewGenerationConfirmation = -1;
    RichpreviewsFilter.confirmationCount = 0;
    mega.attr.set("rp", {}, false, true);
};
