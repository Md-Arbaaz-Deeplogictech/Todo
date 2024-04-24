/** 
 * (C) 2015, 2016, 2017, 2018, 2019, 2020, 2021. TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 * 
 * This is our main API Manager class.
 */

const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const app = require(`${CONSTANTS.LIBDIR}/app.js`);
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const API_REG_DISTM_KEY = "__org_monkshu_apiregistry_key";
let decoders, encoders, headermanagers, securitycheckers;

function initSync(notVerbose) {
	let apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY) || JSON.parse(fs.readFileSync(CONSTANTS.API_REGISTRY));
	if (!CLUSTER_MEMORY.get(API_REG_DISTM_KEY)) CLUSTER_MEMORY.set(API_REG_DISTM_KEY, apireg);

	if (!notVerbose) LOG.info(`Read API registry: ${JSON.stringify(apireg)}`);
	for (const key in apireg) apireg[key] = fs.existsSync(apireg[key].split("?")[0]) ? apireg[key] : (`${CONSTANTS.ROOTDIR}/${apireg[key]}`);

	const decoderPathAndRoots = [{path: CONSTANTS.API_MANAGER_DECODERS_CONF_CORE_SERVER, root: CONSTANTS.ROOTDIR}];
	const encoderPathAndRoots = [{path: CONSTANTS.API_MANAGER_ENCODERS_CONF_CORE_SERVER, root: CONSTANTS.ROOTDIR}];
	const headermanagersPathAndRoots = [{path: CONSTANTS.API_MANAGER_HEADERMANAGERS_CONF_CORE_SERVER, root: CONSTANTS.ROOTDIR}];
	const securitycheckersPathAndRoots = [{path: CONSTANTS.API_MANAGER_SECURITYCHECKERS_CONF_CORE_SERVER, root: CONSTANTS.ROOTDIR}];

	const apps = app.getApps();
	const _toPOSIXPath = pathin => pathin.split(path.sep).join(path.posix.sep)

	for (const appObj of apps) {
		const app = Object.keys(appObj)[0], appRoot = appObj[app];
		if (fs.existsSync(`${appRoot}/conf/apiregistry.json`)) {
			let regThisRaw = fs.readFileSync(`${appRoot}/conf/apiregistry.json`, "utf8").
				replace(/{{app}}/g, app).replace(/{{server}}/g, _toPOSIXPath(CONSTANTS.ROOTDIR)).replace(/{{server_lib}}/g, _toPOSIXPath(CONSTANTS.LIBDIR));
			if (!notVerbose) LOG.info(`Read App API registry for app ${app}: ${regThisRaw}`);
			let regThis = JSON.parse(regThisRaw);
			for (const key in regThis) regThis[key] = fs.existsSync(regThis[key].split("?")[0]) ? regThis[key] : (`${appRoot}/${regThis[key]}`);
			apireg = {...apireg, ...regThis};
		}

		if (fs.existsSync(`${appRoot}/${CONSTANTS.API_MANAGER_DECODERS_CONF_APPS}`)) decoderPathAndRoots.push(
			{path: `${appRoot}/${CONSTANTS.API_MANAGER_DECODERS_CONF_APPS}`, root: appRoot});
		if (fs.existsSync(`${appRoot}/${CONSTANTS.API_MANAGER_ENCODERS_CONF_APPS}`)) encoderPathAndRoots.push(
			{path: `${appRoot}/${CONSTANTS.API_MANAGER_ENCODERS_CONF_APPS}`, root: appRoot});
		if (fs.existsSync(`${appRoot}/${CONSTANTS.API_MANAGER_HEADERMANAGERS_CONF_APPS}`)) headermanagersPathAndRoots.push(
			{path: `${appRoot}/${CONSTANTS.API_MANAGER_HEADERMANAGERS_CONF_APPS}`, root: appRoot});
		if (fs.existsSync(`${appRoot}/${CONSTANTS.API_MANAGER_SECURITYCHECKERS_CONF_APPS}`)) securitycheckersPathAndRoots.push(
			{path: `${appRoot}/${CONSTANTS.API_MANAGER_SECURITYCHECKERS_CONF_APPS}`, root: appRoot});
	}

	CLUSTER_MEMORY.set(API_REG_DISTM_KEY, apireg);

	decoders = _loadSortedConfOjbects(decoderPathAndRoots);
	encoders = _loadSortedConfOjbects(encoderPathAndRoots);
	headermanagers = _loadSortedConfOjbects(headermanagersPathAndRoots);
	securitycheckers = _loadSortedConfOjbects(securitycheckersPathAndRoots);

	for (const decoderThis of decoders) if (decoderThis.initSync) decoderThis.initSync(apireg);
	for (const securitycheckerThis of securitycheckers) if (securitycheckerThis.initSync) securitycheckerThis.initSync(apireg);
	for (const headermanagerThis of headermanagers) if (headermanagerThis.initSync) headermanagerThis.initSync(apireg);
	for (const encoderThis of encoders) if (encoderThis.initSync) encoderThis.initSync(apireg);

	global.APIREGISTRY = this;
}

function getAPI(url) {
	const endPoint = new URL(url).pathname, apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	if (apireg[endPoint]) return path.resolve(_getAPIRegEntryAsURL(apireg[endPoint]).rawpathname);
	else return;
}

function getAPIConf(url) {
	const endPoint = new URL(url).pathname;
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	if (apireg[endPoint]) return _getAPIRegEntryAsURL(apireg[endPoint]).query;
	else return null;
}

function decodeIncomingData(url, data, headers, servObject) {
	const endPoint = new URL(url).pathname;
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	let apiregentry = apireg[endPoint]; if (!apiregentry) return false; apiregentry = _getAPIRegEntryAsURL(apireg[endPoint]);

	let decoded = data;
	for (const decoderThis of decoders) decoded = decoderThis.decodeIncomingData(apiregentry, url, decoded, headers, servObject);

	return decoded;
}

function encodeResponse(url, respObj, reqHeaders, respHeaders, servObject) {
	const endPoint = new URL(url).pathname;
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	let apiregentry = apireg[endPoint]; if (!apiregentry) return false; apiregentry = _getAPIRegEntryAsURL(apireg[endPoint]);

	let encoded = respObj;
	for (const encoderThis of encoders) encoded = encoderThis.encodeResponse(apiregentry, endPoint, encoded, reqHeaders, respHeaders, servObject);

	return encoded;
}

async function checkSecurity(url, req, headers, servObject, reason) {
	const endPoint = new URL(url).pathname;
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	let apiregentry = apireg[endPoint]; if (!apiregentry) { reason = {reason:"API endpoint missing", code:403}; return false; }
	apiregentry = _getAPIRegEntryAsURL(apireg[endPoint]);

	const allSecurityCheckers = [...securitycheckers];
	if (apiregentry.query.customSecurity) for (const securityCheckerCustom of utils.escapedSplit(apiregentry.query.customSecurity, ","))
		allSecurityCheckers.push(global.APIREGISTRY.ENV.CUSTOM_SECURITY_CHECKERS[securityCheckerCustom]);
	for (const securitycheckerThis of allSecurityCheckers) if (securitycheckerThis && 
			(!(await securitycheckerThis.checkSecurity(apiregentry, endPoint, req, headers, servObject, reason)))) { 
		reason.reason += ` ---- Failed on: ${securitycheckerThis.__org_monkshu_apiregistry_conf_modulename}`; 
		return false; 
	}

	return true;
}

const addCustomSecurityChecker = (name, module) => global.APIREGISTRY.ENV.CUSTOM_SECURITY_CHECKERS[name] = module;

const removeCustomSecurityChecker = name => delete global.APIREGISTRY.ENV.CUSTOM_SECURITY_CHECKERS[name];

function injectResponseHeaders(url, response, requestHeaders, responseHeaders, servObject, reqObj) {
	const endPoint = new URL(url).pathname;
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	let apiregentry = apireg[endPoint]; if (!apiregentry) return; apiregentry = _getAPIRegEntryAsURL(apireg[endPoint]);

	for (const headermanagerThis of headermanagers) 
		headermanagerThis.injectResponseHeaders(apiregentry, endPoint, response, requestHeaders, responseHeaders, servObject, reqObj);
}

function listAPIs() {
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY);
	return [...Object.keys(apireg)];	// clone for security
}

async function addAPI(path, apiregentry, app) {
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY), apps = app.getApps(), approot = apps[app];
	apireg[path] = approot?`${approot}/${apiregentry}`:apiregentry;
	CLUSTER_MEMORY.set(API_REG_DISTM_KEY, apireg);
	const regFile = approot?`${approot}/conf/apiregistry.json`:CONSTANTS.API_REGISTRY;
	const regFileObj = JSON.parse(await fs.promises.readFile(regFile));
	regFileObj[path] = apiregentry; await fs.promises.writeFile(regFile, JSON.stringify(regFileObj, null, 4));
}

const editAPI = addAPI;

async function deleteAPI(path, app) {
	const apireg = CLUSTER_MEMORY.get(API_REG_DISTM_KEY), apps = app.getApps(), approot = apps[app]
	if (apireg[path]) delete apireg[path];
	CLUSTER_MEMORY.set(API_REG_DISTM_KEY, apireg);
	const regFile = approot?`${approot}/conf/apiregistry.json`:CONSTANTS.API_REGISTRY;
	const regFileObj = JSON.parse(await fs.promises.readFile(regFile));
	if (regFileObj[path]) delete regFileObj[path]; await fs.promises.writeFile(regFile, JSON.stringify(regFileObj, null, 4));
}

const getExtension = name => require(`${CONSTANTS.LIBDIR}/apiregistry_extensions/${name.toLowerCase()}.js`);

function _loadSortedConfOjbects(pathAndRoots) {
	const sortedConfObjects = []; 
	for (const {path, root} of pathAndRoots) {
		const rawObject = require(path);
		for (const key of Object.keys(rawObject)) sortedConfObjects.push(
			{"module":`${root}/lib/apiregistry_extensions/${key.toLowerCase()}.js`, "priority":rawObject[key]} );
	}
	
	sortedConfObjects.sort((a,b) => (a.priority < b.priority) ? -1 : (a.priority > b.priority) ? 1 : 0);

	for (const [i, confObject] of sortedConfObjects.entries()) {
		sortedConfObjects[i] = require(confObject.module);
		sortedConfObjects[i].__org_monkshu_apiregistry_conf_modulename = path.basename(confObject.module);
	}

	return sortedConfObjects;
}

function _getAPIRegEntryAsURL(endPoint) {	// parses endpoint and converts to URL + legacy properties from url.parse we need
	const retURL = new URL(endPoint, "http://dummyhost/"); 
	retURL.query = querystring.parse(retURL.search!=""?retURL.search.substring(1):""); 
	retURL.rawpathname = retURL.search!=""?endPoint.substring(0, endPoint.indexOf("?")):endPoint;
	retURL.path = retURL.rawpathname+retURL.search; return retURL;
}

module.exports = {initSync, getAPI, getAPIConf, listAPIs, addAPI, editAPI, deleteAPI, decodeIncomingData, checkSecurity, 
	injectResponseHeaders, encodeResponse, getExtension, ENV: {CUSTOM_SECURITY_CHECKERS: {}}, 
	addCustomSecurityChecker, removeCustomSecurityChecker};