Components.utils.import("resource://gre/modules/Services.jsm");
var z;
var console = Services.console;

/**
 * Proxy sys item for passing in to citeproc. Wraps the
 * zotero.Cite.System object, but allows for locally registered items.
 */
var mySys = {
    retrieveLocale : function (lang) {
        return zotero.Cite.System.retrieveLocale(lang);
    },
    retrieveItem : function(id) { 
        if (zotero.localItems[id] != undefined) {
            return zotero.localItems[id];
        } else { 
            return zotero.Cite.System.retrieveItem(id);
        }
    }
};

function makeCslEngine (styleId) {
    if (!styleId.match(/^http:/)) {
	styleId = 'http://www.zotero.org/styles/' + styleId;
    }
    var style = z.Styles.get(styleId);
    if (!style) {
        return null;
    } else {
        return style.getCiteProc(true);
    }
}

function findByEasyKey(key) {
    var re = new RegExp("^([A-Z][a-z]+)([A-Z][a-z]+)?([0-9]+)?");
    var result = re.exec(key);
    if (!result) {
        throw {'name': "EasyKeyError", "message": "EasyKey must be of the form DoeTitle2000"};
    } else {
        var creator = result[1];
        var title = result[2];
        var date = result[3];
        
        var s = new z.Search();
        s.addCondition("creator", "contains", creator);
        if (title != null) {
        s.addCondition("title", "contains", title);
        }
        if (date != null) {
            s.addCondition("date", "is", date);
        }
        var i = s.search();
        if (!i) {
            throw {'name': "EasyKeyError", "message": "search failed to return a single item"};
        } else if (i.length == 0) {
            throw {'name': "EasyKeyError", "message": "search failed to return a single item"};
        } else if (i.length > 1) {
            throw {'name': "EasyKeyError", "message": "search return multiple items"};
        } else {
            return z.Items.get(i[0]);
        }
    }
}

var endpoints = {
    "bibliography" : {
        "supportedMethods":  ["POST"],
        "supportedDataTypes": ["application/json"],
        "init": function (url, data, sendResponseCallback) {
            var cslEngine = makeCslEngine(data["styleId"]);
            if (!cslEngine) {
                sendResponseCallback(400, "text/plain", "No style found.");
                return;
            } else {
                //zotero.localItems = {};
                cslEngine.setOutputFormat("html");
                function flatten(a) {
                    return [].concat.apply([], a);
                }
                var citations = data["citations"];
                var citationItems = citations.map(function (c) { 
                    return c["citationItems"]; 
                });
                var citationEasyKeys = flatten(citationItems).map (function (c) { 
                    return c["easyKey"];
                });
                var keys = flatten(citationEasyKeys);
                try {
                    var items = keys.map(findByEasyKey);
                    var ids = items.map(function(c){ return c.id; });
                    cslEngine.updateItems(ids);
                    var retval = {};
                    retval["bibliography"] = cslEngine.makeBibliography();
                    sendResponseCallback(200, "application/json", JSON.stringify(retval));
                    return;
                } catch (ex if (ex.name === "EasyKeyError")) {
                    sendResponseCallback(400, "text/plain", ex.message);
                }
            }
        }
    },
    "items" : {
	"supportedMethods":["GET"],
        "supportedDataType" : ["application/x-www-form-urlencoded"],
        "init" : function (url, data, sendResponseCallback) {
            var q = url['query'];
            var items = [];
            if (q["selected"]) {
                var ZoteroPane = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow("navigator:browser").ZoteroPane;
                items = ZoteroPane.getSelectedItems();
                if (!items) { items = []; }
            } else if (q["key"]) {
                items = q["key"].split(",").map(function (key) {
                    var lkh = z.Items.parseLibraryKeyHash(key);
                    return z.Items.getByLibraryAndKey(lkh.libraryID, lkh.key);
                });
            } else if (q["easykey"]) {
                try {
                    items = q["easykey"].split(",").map(function (key) {
                        return findByEasyKey(key);
                    });
                } catch (ex if (ex.name === "EasyKeyError")) {
                    sendResponseCallback(400, "text/plain", ex.message);
                    return;
                }
            } else {
                sendResponseCallback(400, "text/plain", "No param supplied!");
                return;
            }
            if (q['format'] == 'key') {
                var responseData = items.map (function (item) {
                    return ((item.libraryID || "0") + "_" + item.key);
                });
                sendResponseCallback(200, "application/json; charset=UTF-8", 
                                     JSON.stringify(responseData));
                return;
            } else if (q['format'] == 'bibliography') {
                var responseData = items.map (function (item) {
                    // TODO - make the default style correct
                    var style = q['style'] || "http://www.zotero.org/styles/chicago-note-bibliography"
                    return z.QuickCopy.getContentFromItems(new Array(item), "bibliography=" + style);
                });
                sendResponseCallback(200, "application/json; charset=UTF-8",
                                     JSON.stringify(responseData));
                return;
            } else {
                var responseData = items.map (function (item) {
                    return z.Utilities.itemToCSLJSON(item);
                });
                sendResponseCallback(200, "application/json; charset=UTF-8", 
                                     JSON.stringify(responseData));
                return;
            }
        }
    }
}

/**
 * Function to load our endpoints into the Zotero connector server.
 */
function loadEndpoints () {
    z = Components.classes["@zotero.org/Zotero;1"].
        getService(Components.interfaces.nsISupports).wrappedJSObject;
    
    for (e in endpoints) {
        var ep = z.Server.Endpoints["/zotxt/" + e] = function() {};
        ep.prototype = endpoints[e];
    }
}
    
function startup(data, reason) {
    /* wait until after zotero is loaded */
    var observerService = Components.classes["@mozilla.org/observer-service;1"].
        getService(Components.interfaces.nsIObserverService);
    observerService.addObserver(
        { 
            "observe": function(subject, topic, data) { 
                loadEndpoints(); 
            }
        },
        "final-ui-startup", false);
}


function shutdown (data, reason) {
    /* pass */
}

function uninstall(data, reason) {
    /* pass */
}

function install(data, reason) {
    /* turn on http server if it is not on */
    /* TODO turn this off when uninstalled? */
    var prefs = Components.classes["@mozilla.org/preferences-service;1"]
        .getService(Components.interfaces.nsIPrefService).getBranch("extensions.zotero.");
    prefs.setBoolPref("httpServer.enabled", true);
}
