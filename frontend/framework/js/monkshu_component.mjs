/** 
 * (C) 2018 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 * 
 * Web component support. All Monkshu components must call the register function. 
 * Supports both true web component mode or simulated web components (not recommended).
 * 
 * Access to the element's javascript module is via window.monkshu_env.components[name]
 * 
 * Dynamic data binding is then via monkshu_env.components[name].bindData(data, id).
 */

import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {blackboard} from "/framework/js/blackboard.mjs";
import {securityguard} from "/framework/js/securityguard.mjs";

const BLACKBOARD_MESSAGE_COMPONENT_RENDERED = "__org_monkshu_component_rendered";

function register(name, htmlTemplate, module) {
    if (window.monkshu_env.components[name]) return;    // already registered
    
    module.bindData = async (data, id) => { // allow binding of data and dynamic DOM updates
        if (module.dataBound) data = await module.dataBound(id?module.elements[id]:module.element, data);   // if a data bound listner is provided tell it we are about to rebind data
        module.setData(id, data);

        if (id && module.elements && module.elements[id]) await module.elements[id].render();
        else if ((!id) && module.element) await module.element.render();
    }
    module.bindDataByHost = (host, data) => module.bindData(data, host.id);
    module.bindDataByContainedElement = (element, data) => module.bindData(module.getHostElementID(element), data);

    module.getData = id => id?module.datas?.[id]:module.data;
    module.getDataByHost = host => module.getData(host.id);
    module.getDataByContainedElement = element => module.getData(module.getHostElementID(element));

    module.getHostElementByID = id => id && module.elements && module.elements[id] ? module.elements[id] :  module.element;
    module.getHostElementByContainedElement = module.getHostElement = element => {
        if (element.tagName.toLowerCase() == name.toLowerCase()) return element;    // it is the host already
        else return module.trueWebComponentMode ? element.getRootNode().host : element.closest(name);
    }
    module.getHostElementID = element => module.getHostElement(element).id;

    module.getShadowRootByHost = host => module.getShadowRootByHostId(host.id);
    module.getShadowRootByHostId = id => id ? (module.shadowRoots ? module.shadowRoots[id] : null) : module.shadowRoot;
    module.getShadowRootByContainedElement = element => module.getShadowRootByHostId(module.getHostElementID(element));

    module.getMemory = id => {
        id = !id || id == "" ? "__org_monkshu_element_no_id" : id;
        if (!module.memory) module.memory = {}; if (!module.memory[id]) module.memory[id] = {}; return module.memory[id];
    }

    module.clearMemory = id => {
        id = !id || id == "" ? "__org_monkshu_element_no_id" : id;
        if (module.memory) delete module.memory[id];
    }

    module.getSessionMemory = id => {
        if (!session.get(`__org_monkshu_element_${name}_memory`)) session.set(`__org_monkshu_element_${name}_memory`, {});
        const memory = session.get(`__org_monkshu_element_${name}_memory`);
        id = !id || id == "" ? "__org_monkshu_element_no_id" : id; if (!memory[id]) memory[id] = {}; 
        return memory[id];
    }

    module.clearSessionMemory = id => {
        const memory = session.get(`__org_monkshu_element_${name}_memory`) || {};
        id = !id || id == "" ? "__org_monkshu_element_no_id" : id;
        if (memory[id]) delete memory[id]; session.set(`__org_monkshu_element_${name}_memory`, memory);
    }

    module.getMemoryByContainedElement = element => module.getMemory(module.getHostElementID(element));

    module.getMemoryByHost = hostElement => module.getMemory(hostElement.id);

    module.getSessionMemoryByContainedElement = element => module.getSessionMemory(module.getHostElementID(element));

    module.getSessionMemoryByHost = hostElement => module.getSessionMemory(hostElement.id);

    module.getAllElementInstances = _ => {
        const allInstances = []; 
        if (module.elements) for (const key in module.elements) allInstances.push(module.elements[key]); 
        else if (module.element) allInstances.push(module.element);
        return allInstances;
    }

    module.reload = async id => {
        module.clearMemory(id);  const host = module.getHostElementByID(id);
        if (module.elementConnected) await module.elementConnected(host); 
        await host.render(false);
    }

    module.getComponentPath = meta => `${meta.url.substring(0,meta.url.lastIndexOf("/"))}`;

    module.getTemplateHTML = host => host._componentHTML;
    module.setTemplateHTML = (host, html) => host._componentHTML = html;

    module.setData = (hostID, data) => {
        if (hostID) {
            if (!module.datas) {module.datas = {}; module.datas[hostID] = data;} 
            else module.datas[hostID] = data;
        } else module.data = data;
    }
    module.setDataByHost = (host, data) => module.setData(host.id, data);
    module.setDataByContainedElement = (element, data) => module.setData(module.getHostElementID(element), data);

    module.getAttrValue = async (host, attr) => {
        const str = host.getAttribute(attr); if (!str) return null;
        await $$.require("/framework/3p/xregexp-all.js");

        let val = ((window[str] && (!window[str] instanceof Object)) || str).toString();	// Mustache expects strings only

        const _xregexparrayToObject = array => {const retObj = {}; for (const object of array) retObj[object.name] = object.value; return retObj;}

        const _recursiveExpandFunctions = async val => {
            const testForAttrFunctions = _xregexparrayToObject(XRegExp.matchRecursive(val, "\\(", "\\)", "g", 
                {valueNames: ["cmd","left","match","right"]}));
            if (!testForAttrFunctions.match || (testForAttrFunctions.cmd != "url" && 
                testForAttrFunctions.cmd != "decodeURIComponent")) return val;	// nothing to expand
            val = await _recursiveExpandFunctions(testForAttrFunctions.match);

            if (testForAttrFunctions.cmd == "url") try {val = (await $$.requireText(val)).replace(/\r?\n|\r/g, "");} catch {}	// remove line feeds
            else if (testForAttrFunctions.cmd=="decodeURIComponent") val = decodeURIComponent(val);
            return val;
        }
        
        val = await _recursiveExpandFunctions(val);
        return val;
    }

    module.hasBeenRendered = host => host.__org_monkshu_hasBeenRendered?true:false;

    // register the web component
    if (!customElements.get(name)) customElements.define(name, class extends HTMLElement {

        static async _diffApplyDom(oldDom, newDom) {
            await $$.require("/framework/3p/diffDOM.js");
            const dd = new diffDOM();
            const diff = dd.diff(oldDom, newDom);
            dd.apply(oldDom, diff);
        }

        async render(initialRender=this.__org_monkshu_hasBeenRendered?false:true) {
            // check security policy
            if (this.hasAttribute("roles") && !securityguard.isAllowed(name) && !securityguard.isAllowed(name+this.id)) return;

            if (module.elementPrerender) await module.elementPrerender(this, initialRender);

            // if it has template, or if the component already provided some HTML then honor it,
            // else make it an invisible component, as it has no HTML (case: pure JS components).
            if (htmlTemplate) this._componentHTML = await router.loadHTML(htmlTemplate,
                this.id?(module.datas?module.datas[this.id]||{}:{}):module.data||{}, false);
            else if (!this._componentHTML) this._componentHTML = '<body style="margin: 0px; padding: 0px; height: 0px; display: none">';

            const templateRoot = new DOMParser().parseFromString(this._componentHTML, "text/html").documentElement;
            
            if (module.trueWebComponentMode) {
                if (initialRender) {
                    this.attachShadow({mode: "open"}).appendChild(templateRoot);
                    await router.runShadowJSScripts(this.shadowRoot, this.shadowRoot);
                    if (this.id) {if (!module.shadowRoots) module.shadowRoots = {}; module.shadowRoots[this.id]=this.shadowRoot;}
                    else module.shadowRoot = this.shadowRoot;
                }
                else if (this.shadowRoot.firstChild) await this.constructor._diffApplyDom(this.shadowRoot.firstChild, templateRoot);
            }
            else {  
                if (initialRender) {
                    this.appendChild(templateRoot); 
                    await router.runShadowJSScripts(templateRoot, document);
                    templateRoot.getElementById = id => templateRoot.querySelector(`#${id}`);
                    if (this.id) {if (!module.shadowRoots) module.shadowRoots = {}; module.shadowRoots[this.id]=templateRoot;}
                    else module.shadowRoot = templateRoot;
                } else if (this.firstChild) await this.constructor._diffApplyDom(this.firstChild, templateRoot);
            }

            this.__org_monkshu_hasBeenRendered = true;
            if (module.initialRender && initialRender) await module.initialRender(this);
            if (module.elementRendered) await module.elementRendered(this, initialRender);
            blackboard.broadcastMessage(BLACKBOARD_MESSAGE_COMPONENT_RENDERED, `${name}#${this.id||"undefined"}`);
        }

        async connectedCallback() {
            if (!this.isConnected) return;  // not in a DOM tree
            
            if (this.id) {if (!module.elements) module.elements = {}; module.elements[this.id] = this;}
            else module.element = this;

            if (this.hasAttribute("onload")) await eval(this.getAttribute("onload"));
            module.clearMemory(this.id);
            if (module.elementConnected) await module.elementConnected(this);
            if (this.hasAttribute("roles")) for (const role of JSON.parse(this.getAttribute("roles"))) 
                securityguard.addPermission(this.id ? name+this.id : name, role);
            
            this.render();  
        }
        
        disconnectedCallback() {
            if (this.id) delete module.elements[this.id];
            else delete module.element;

            delete module.data;
            delete module.datas;
        }

        async attributeChangedCallback(name, oldValue, newValue) {
            if (module.attributeChanged && module.hasBeenRendered(this)) 
                await module.attributeChanged(this, name, oldValue, newValue);
            else if (module.attributeChangedBeforeRendering) 
                await module.attributeChangedBeforeRendering(this, name, oldValue, newValue);
        }

        static get observedAttributes() {
            if (module.getObservedAttributes) return module.getObservedAttributes(this);
            else return [];
        }
    });

    // insert into namespace
    window.monkshu_env.components[name] = module;
}

export const monkshu_component = {register, BLACKBOARD_MESSAGE_COMPONENT_RENDERED}