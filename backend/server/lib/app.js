/* 
 * (C) 2015, 2016, 2017, 2018, 2019, 2020. TekMonks. All rights reserved.
 * License: MIT - see enclosed LICENSE file.
 * 
 * Handles apps.
 */

const fs = require("fs");
const appRoots = [];

function initSync() {
    for (const approotdir of (CONSTANTS.APPROOTDIRS||[CONSTANTS.APPROOTDIR])) if (fs.existsSync(approotdir)) 
            for (const app of fs.readdirSync(approotdir)) {
        
                appThis = {}; appThis[app] = `${approotdir}/${app}`; 
        appRoots.push(appThis);
    }
}

function initAppsSync() {
    for (const appEntry of appRoots) {
        const app = Object.keys(appEntry)[0];
        if (fs.existsSync(`${appEntry[app]}/lib/app.js`)) {
            LOG.info(`Initializing app: ${app}`);
            const appThis = require(`${appEntry[app]}/lib/app.js`); if (appThis.initSync) appThis.initSync(app); 
        }
    }
}

const getApps = _ => appRoots;

module.exports = {initSync, getApps, initAppsSync}