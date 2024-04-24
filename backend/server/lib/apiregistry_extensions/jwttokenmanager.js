/** 
 * (C) 2020 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 * 
 * Tokens are in JWT & JWS format - RFCs 7515 & 7519. 
 * https://datatracker.ietf.org/doc/html/rfc7515
 * https://datatracker.ietf.org/doc/html/rfc7519
 */

const _jwttokenListeners = [];
const cryptmod = require("crypto");
const mustache = require("mustache");
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const TOKENMANCONF = CONSTANTS.ROOTDIR+"/conf/apitoken.json";
const API_TOKEN_CLUSTERMEM_KEY = "__org_monkshu_jwttokens_key";

const BASE_64_HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // {"alg":"HS256","typ":"JWT"} in Base 64 

let conf, alreadyInit = false;

function initSync() {
    if (alreadyInit) return; else alreadyInit = true;

    // Init tokens in Cluster Memory
    if (!CLUSTER_MEMORY.get(API_TOKEN_CLUSTERMEM_KEY)) CLUSTER_MEMORY.set(API_TOKEN_CLUSTERMEM_KEY, {});

    try {conf = require(TOKENMANCONF);} catch (err) {conf = {}}
    // Default config if none was specified with 10 minute expiry and 30 min cleanups
    conf.expiryInterval = conf.expiryInterval || 600000; conf.tokenGCInterval = conf.tokenGCInterval || 1800000;

    setInterval(_cleanTokens, conf.tokenGCInterval);   
}

const checkHeaderToken = headers => checkSecurity({query:{needsToken: true}}, undefined, {}, headers, undefined, {});

function checkSecurity(apiregentry, _url, req, headers, _servObject, reason) {
    if ((!apiregentry.query.needsToken) || (apiregentry.query.needsToken.toLowerCase() == "false")) return true;	// no token needed

    const incomingToken = headers["authorization"];
    const token_splits = incomingToken?incomingToken.split(/[ \t]+/):[];
    if (token_splits.length == 2 && token_splits[0].trim().toLowerCase() == "bearer") return checkToken(token_splits[1], reason, apiregentry.query.needsToken, apiregentry.query.checkClaims, req);
    else {reason.reason = `JWT malformatted. Got token ${incomingToken}`; reason.code = 403; return false;}	// missing or badly formatted token
}

function checkToken(token, reason={}, accessNeeded, checkClaims, req) {
    const activeTokens = CLUSTER_MEMORY.get(API_TOKEN_CLUSTERMEM_KEY);
    const lastAccess = activeTokens[token]; // this automatically verifies token integrity too, and is a stronger check than rehashing and checking the hash signature
    if (!lastAccess) {reason.reason = "JWT Token Error, no last access found"; reason.code = 403; return false;}

    let claims; try{ claims = JSON.parse(Buffer.from(token.split(".")[1],"base64").toString("utf8")); } catch (err) {
        LOG.error(`Error parsing claims ${err}`); 
        {reason.reason = "JWT Token Error, claims are not parseable"; reason.code = 403; return false;}
    } 

    if (Date.now() - lastAccess > claims.expiryInterval) {reason.reason = "JWT Token Error, expired"; reason.code = 403; return false;} 

    if (accessNeeded && accessNeeded.toLowerCase() != "true" && (!utils.escapedSplit(accessNeeded, ",").includes(claims.sub))) {
        reason.reason = `JWT Token Error, sub:claims doesn't match needed access level. Claims are ${JSON.stringify(claims)} and needed access is ${accessNeeded}.`; 
        reason.code = 403; return false;
    }

    if (checkClaims) for (const key of checkClaims.split(",")) if (claims[key] != req[key]) {
        reason.reason = `JWT Token Error, claims check failed. Claims keys is ${key}, found JWT claim ${claims[key]}, request claims ${req[key]}.`; 
        reason.code = 403; return false;
    }

    updateLastAccessOrAddToken(token);
    return true;
}

function updateLastAccessOrAddToken(token) {
    const activeTokens = CLUSTER_MEMORY.get(API_TOKEN_CLUSTERMEM_KEY);
    activeTokens[token] = Date.now();   // update last access
    CLUSTER_MEMORY.set(API_TOKEN_CLUSTERMEM_KEY, activeTokens)  // update tokens across workers
}

function releaseToken(token) {
    const activeTokens = CLUSTER_MEMORY.get(API_TOKEN_CLUSTERMEM_KEY);
    if (token && activeTokens[token]) {
        delete activeTokens[token];
        CLUSTER_MEMORY.set(API_TOKEN_CLUSTERMEM_KEY, activeTokens)  // update tokens across workers
    }
}

function injectResponseHeaders(apiregentry, url, response, requestHeaders, responseHeaders, servObject, request) {
    if (!apiregentry.query.addsToken) return;   // nothing to do
    else injectResponseHeadersInternal(apiregentry, url, response, requestHeaders, responseHeaders, servObject, request);
}

function injectResponseHeadersInternal(apiregentry, url, response, requestHeaders, responseHeaders, servObject, request) {
    const addsTokenParsed = _parseAddstokenString(apiregentry.query.addsToken, request, response);
    if (addsTokenParsed.tokenflag && !(utils.parseBoolean(addsTokenParsed.tokenflag))) return; // failed to pass the API success test 
    if ((!addsTokenParsed.tokenflag) && (!response.result)) return; // failed to pass the API success test 
    
    const token = createSignedJWTToken(addsTokenParsed);
    
    // inject the JWT token into the response headers
    responseHeaders.access_token = token; responseHeaders.token_type = "bearer"; responseHeaders.authorization = `Bearer ${token}`;
    for (const tokenListener of _jwttokenListeners) tokenListener("token_generated", {token, apiregentry, url, response, requestHeaders, responseHeaders, servObject});
}

const addListener = listener => _jwttokenListeners.push(listener);
const removeListener = listener => { if (_jwttokenListeners.indexOf(listener) != -1)
    _jwttokenListeners.splice(_jwttokenListeners.indexOf(listener),1); }

function createSignedJWTToken(jwtproperties) {
    const timenow = Date.now(), timenowEPOCH = Math.round(timenow/1000), 
        expiryInterval = parseInt(jwtproperties.expiryInterval || conf.expiryInterval), claims = {
            iss: TOKENMANCONF.iss||"Monkshu", 
            iat: timenowEPOCH, iatms: timenow, nbf: timenowEPOCH, exp: timenowEPOCH+expiryInterval, 
            jti: cryptmod.randomBytes(16).toString("hex"), expiryInterval, ...jwtproperties
        }; 

    const claimB64 = Buffer.from(JSON.stringify(claims)).toString("base64"); 
    const tokenClaimHeader = claimB64+"."+BASE_64_HEADER;

    const sig64 = cryptmod.createHmac("sha256", cryptmod.randomBytes(32).toString("hex")).update(tokenClaimHeader).digest("hex");

    const token = `${BASE_64_HEADER}.${claimB64}.${sig64}`;
    updateLastAccessOrAddToken(token);
    
    return token;
}

const getClaims = headersOrToken => {
    const token = (typeof headersOrToken === "string") ? headersOrToken : getToken(headersOrToken); if (!token) return {}; 
    try {return JSON.parse(Buffer.from(token.split(".")[1],"base64").toString("utf8"))} catch (err) {return {};}
}

const getToken = headers => headers["authorization"];

function _cleanTokens() {
    const activeTokens = CLUSTER_MEMORY.get(API_TOKEN_CLUSTERMEM_KEY);
    for (let token of Object.keys(activeTokens)) {
        const claims = getClaims(token);
        if (Date.now() - activeTokens[token] > claims.expiryInterval) {
            delete activeTokens[token];
            for (const tokenListener of _jwttokenListeners) tokenListener("token_expireed", token);
        }
    }
    CLUSTER_MEMORY.set(API_TOKEN_CLUSTERMEM_KEY, activeTokens)  // update tokens across workers
    
}

function _parseAddstokenString(addsTokenString, request, response) {
    const retObj = {}, splits = utils.escapedSplit(addsTokenString, ","); 
    for (const split of splits) {
        const tuple = split.split(":"), key = tuple[0], value = tuple.slice(1).join(":"), 
            renderedFromResponse = mustache.render(value, response), renderedFromRequest = mustache.render(value, request);
        retObj[key] =  renderedFromResponse != "" ? renderedFromResponse : (renderedFromRequest != "" && key != "flag" ? 
            renderedFromRequest : value);
    }

    return retObj;
}

module.exports = { checkSecurity, injectResponseHeaders, injectResponseHeadersInternal, initSync, checkToken,
    createSignedJWTToken, addListener, removeListener, checkHeaderToken, addToken: updateLastAccessOrAddToken, releaseToken, getToken, getClaims };