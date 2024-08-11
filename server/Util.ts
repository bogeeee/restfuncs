// Diagnosis for web packagers. Please keep this at the file header:
import {Buffer} from 'node:buffer'; // *** If you web packager complains about this line, it did not properly (tree-)shake off your referenced ServerSession class and now wants to include ALL your backend code, which is not what we want. It can be hard to say exactly, why it decides to follow (not tree-shake) it, so Keep an eye on where you placed the line: `new RestfuncsClient<YourServerSession>(...)` or where you included YourServerSession in a return type. **
Buffer.alloc(0); // Provoke usage of some stuff that the browser doesn't have. Keep this here !

import escapeHtml from "escape-html";
import crypto from "node:crypto"
import {Request} from "express";
import URL from "url";
import {CommunicationError} from "./CommunicationError";
import {reflect} from "typescript-rtti";

/**
 * Enhances the funcs object with enhancementProps temporarily with a proxy during the call of callTheFunc
 *
 * The proxy is used to prevent resource conflicts with other (callThe-)funcs. Note that callTheFunc runs asyncronously, so in theory at the same time / overlapping with other funcs.
 * This way, only code inside callTheFunc can access the enhancementProps.
 * @param funcs
 * @param enhancementProps These properties are virtually applied to the funcs object
 * @param callTheFunc
 */
export async function enhanceViaProxyDuringCall<F extends Record<string, any>>(funcs: F, enhancementProps: Partial<F>, callTheFunc: (funcsProxy: F) => any, diagnosis_funcName: string) {
    // Create a proxy:
    let callHasEnded = false;
    const funcsProxy = new Proxy(funcs, {
        get(target: F, p: string | symbol, receiver: any): any {

            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new Error(`Unhandled : ${String(p)}`);
            }

            // get a property that should be enhanced ?
            if (enhancementProps[p] !== undefined && {}[p] === undefined) { // In enhancement props but exclude standard props from objects like 'constructor'
                if (callHasEnded) {
                    throw new Error(`Cannot access .${p} after the call to ${diagnosis_funcName}(...) has ended.`);
                }
                return enhancementProps[p];
            }

            if (callHasEnded) {
                throw new Error(`You must not hand out the this object from inside your ${diagnosis_funcName}(...) function. This is because 'this' is only a proxy (to make req, res, ... available) but it MUST NOT be referenced after the call to prevent resources leaks.`);
            }

            return target[p]; // normal property
        },

        set(target: F, p: string | symbol, newValue: any, receiver: any): boolean {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new CommunicationError(`Unhandled : ${String(p)}`)
            }

            if (callHasEnded) {
                throw new Error(`Cannot write to the session, after the call to ${diagnosis_funcName}(...) has ended.`);
            }

            // @ts-ignore
            target[p] = newValue;
            return true;
        }
    });

    try {
        await callTheFunc(funcsProxy);
    } finally {
        callHasEnded = true;
    }
}

/**
 * @return Value with big "V"
 */
export function Camelize(value: string) {
    if(value == "") {
        return "";
    }
    return value.substring(0,1).toUpperCase() + value.substring(1);
}

export type ErrorWithExtendedInfo = Error & { cause?: Error, fileName?: string, lineNumber?: Number, columnNumber?: Number, stack?: string };

export function errorToHtml(e: any): string {
    // Handle other types:
    if(!e || typeof e !== "object") {
        return `<pre>${escapeHtml(String(e))}</pre>`;
    }
    if(!e.message) { // e is not an ErrorWithExtendedInfo ?
        return `<pre>${escapeHtml(JSON.stringify(e))}</pre>`;
    }
    e = <ErrorWithExtendedInfo> e;

    let title= (e.name ? `${e.name}: `: "") + (e.message || String(e))

    return `<b><pre>${escapeHtml( title)}</pre></b>` +
        (e.stack ? `\n<pre>${escapeHtml(e.stack)}</pre>` : '') +
        (e.fileName ? `<br/>\nFile: ${escapeHtml(e.fileName)}` : '') + (e.lineNumber ? `, Line: ${escapeHtml(e.lineNumber)}` : '') + (e.columnNumber ? `, Column: ${escapeHtml(e.columnNumber)}` : '') +
        (e.cause ? `<br/>\nCause:<br/>\n${errorToHtml(e.cause)}` : '')
}


export function diagnisis_shortenValue(evil_value: any) : string {
    if(evil_value === undefined) {
        return "undefined";
    }

    if(evil_value === null) {
        return "null";
    }

    let objPrefix = "";
    if(typeof evil_value == "object" && evil_value.constructor?.name && evil_value.constructor?.name !== "Object") {
        objPrefix = `class ${evil_value.constructor?.name} `;
    }



    function shorten(value: string) {
        const MAX = 50;
        if (value.length > MAX) {
            return value.substring(0, MAX) + "..."
        }
        return value;
    }

    try {
        return shorten(objPrefix + betterJsonStringify(evil_value));
    }
    catch (e) {
    }

    if(typeof evil_value == "string") {
        return shorten(evil_value)
    }
    else if(typeof evil_value == "object") {
        return `${objPrefix}{...}`;
    }
    else {
        return "unknown"
    }

    /**
     * Like JSON.stringify, but support for some additional types.
     *
     * @param value
     */
    function betterJsonStringify(value: unknown) {
        return JSON.stringify(value,(key, val) => {
            if(val === undefined){
                return "undefined"
            }
            else if(typeof val === 'number' && isNaN(val)){
                return "NaN";
            }
            else if(val !== null && JSON.stringify(val) === "null") {
                return "-unknown type-";
            }
            else if(val instanceof Set) {
                return "-Set(...)-";
            }
            else if(val instanceof Map) {
                return "-Map(...)-";
            }
            else if(val instanceof RegExp) {
                return "-Regexp(...)-";
            }
            return val;
        });
    }

}


/**
 * Scrambles a Buffer with a random nonce, so it can't be read out by BREACH attacks.
 * Formats it as string in the form<br/>
 * <code>
 * [Nonce as hex]--[xor'ed content as hex].
 * </code>
 * <br/>I.e.<br/>
 * <code>021cc798cdb5dd--637ea4fca8d3ba</code>
 */
export function shieldTokenAgainstBREACH(input: Buffer) {
    const length = input.length;

    const randomNonce = crypto.randomBytes(length);

    const xorEdContent = Buffer.alloc(length)
    for (let i = 0; i < length; i++) {
        xorEdContent[i] = randomNonce[i] ^ input[i];
    }

    return  randomNonce.toString("hex") + "--" + xorEdContent.toString("hex")
}

/**
 * @see shieldTokenAgainstBREACH
 */
export function shieldTokenAgainstBREACH_unwrap(shieldedToken: string) {
    if(shieldedToken.length < 2 ||(shieldedToken.length % 2 !== 0) ) {
        throw new Error(`Malformed token: ${shieldedToken}. Make sure it has the form XXXXXX--XXXXXX (any number of X)`)
    }

    const seperatorPos = shieldedToken.length / 2 - 1;
    const nonce = Buffer.from( shieldedToken.substring(0, seperatorPos), "hex")
    const separator = shieldedToken.substring(seperatorPos, seperatorPos+2)
    const xorEdContent =  Buffer.from(  shieldedToken.substring(seperatorPos+2), "hex")

    if(separator !== "--") {
        throw new Error(`Malformed token: ${shieldedToken}. Make sure it has the form XXXXXX--XXXXXX (any number of X)`)
    }

    const resultLength = xorEdContent.length;
    if(nonce.length != resultLength) {
        throw new Error("Nonce length not valid");
    }


    const resultBuffer = Buffer.alloc(resultLength)
    for (let i = 0; i < seperatorPos; i++) {
        resultBuffer[i] = nonce[i] ^ xorEdContent[i];
    }

    return  resultBuffer
}

/**
 *
 * @param req
 * @return true for older browsers that are blacklisted for not supporting CORS or disregarding same-origin-policy / execute cross-origin blindly / having problems with that / having an unclear situation there
 */
export function browserMightHaveSecurityIssuseWithCrossOriginRequests(req: { userAgent: string }) {
    // Browsers blacklisted, according to: https://caniuse.com/cors

    // See https://www.useragentstring.com
    // TODO: pre-instantiate all those regexps for better performance

    if (req.userAgent.indexOf("Opera Mini") >= 0) {
        return true;
    }
    // Some opera mini may still slip through: https://stackoverflow.com/questions/36320204/opera-mini-user-agent-string-does-not-contain-opera-mini

    if (/Chrome\/[0-4]\./.test(req.userAgent)) {
        return true;
    }


    // Safari < 6:
    if (/like Gecko\) Safari/.test(req.userAgent)) {
        return true;
    }
    if (/Version\/[0-5]\.[0-9.]* (Mobile\/[^ ]+ )?Safari/.test(req.userAgent)) {
        return true;
    }
    // Version 6-16 "does not support CORS <video> in <canvas> but in that case, it blocks the access itsself, so this functions doesn't need to report it. https://bugs.webkit.org/show_bug.cgi?id=135379

    // Opera
    const operaVersionResult = /Opera[/ ]([\d.]+)/.exec(req.userAgent);
    if (operaVersionResult) {
        return parseFloat(operaVersionResult[1]) < 12
    }
    if (/Opera$/.test(req.userAgent)) { // Early version with Opera at the end ?
        return true;
    }
    // Some Opera 10-11 hide themselfes as IE (probably <= 10). These are blacklisted anyway


    // Firefox: Block at least all til 2016-08-21, cause, according to the comments in https://bugzilla.mozilla.org/show_bug.cgi?id=918767, there could be a real security issue
    const ffVersionResult =  /Firefox\/([\d.]+)/.exec(req.userAgent)
    if(ffVersionResult && parseFloat(ffVersionResult[1]) < 71) { // Version < 71 is rather pessimistic for the above issue. Could be refined to a lower version.
        return true;
    }


    // Internet Exporer < 11
    if (/MSIE ([0-9]|10)[^0-9]/.test(req.userAgent)) {
        return true;
    }

    // Android Browser (AOSP):
    function isAOSP(navU: string) {
        // Taken from https://stackoverflow.com/questions/14403766/how-to-detect-the-stock-android-browser

        // Android Mobile
        var isAndroidMobile = navU.indexOf('Android') > -1 && navU.indexOf('Mozilla/5.0') > -1 && (navU.indexOf('AppleWebKit') > -1 || navU.indexOf('AppleWebkit') > -1);

        // Apple webkit
        var regExAppleWebKit = /AppleWebKit\/([\d.]+)/i;
        var resultAppleWebKitRegEx = regExAppleWebKit.exec(navU);
        var appleWebKitVersion = (resultAppleWebKitRegEx === null ? null : parseFloat(resultAppleWebKitRegEx[1]));

        // Chrome
        var regExChrome = /Chrome\/([\d.]+)/;
        var resultChromeRegEx = regExChrome.exec(navU);
        var chromeVersion = (resultChromeRegEx === null ? null : parseFloat(resultChromeRegEx[1]));

        // Bugfix: It returns true for some (tested myself, see tests) **Chrome** browsers on some 2023 phones. They still have appleWebKitVersion < 538. So we rather focus on the following tip (from stackoverflow) to quickly filter these out:
        // > Edit 4: The recommended solution is to look for Android without Chrome in the user agent as per: https://developer.chrome.com/multidevice/user-agent#webview_user_agent
        if(chromeVersion !== null && ( (appleWebKitVersion || 0) >= 535)) { // still checking for the appleWebKitVersion version, to not catch get the stackoverflow OP's browser here
            return false;
        }

        return isAndroidMobile && (appleWebKitVersion !== null && appleWebKitVersion < 538) || (chromeVersion !== null && chromeVersion < 37);
    }

    if (isAOSP(req.userAgent)) {
        return true;
    }

    return false;
}

export function diagnosis_isAnonymousObject(o: object) {
    if (o.constructor?.name === "Object") {
        return true;
    }

    return false;
}

/**
 * Creates a proxy for the session object that sees the values from the prototype and only writes values to req.session on modification.
 * @param session the real / target session object
 * @param sessionPrototype object that contains the initial values
 */
export function createProxyWithPrototype(session: Record<string, any>, sessionPrototype: Record<string, any>) {
    return new Proxy(session, {
        get(target: Record<string, any>, p: string | symbol, receiver: any): any {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new CommunicationError(`Unhandled : ${String(p)}`)
            }

            if (target[p] === undefined) {
                return sessionPrototype[p];
            }
            return target[p];
        },
        set(target: Record<string, any>, p: string | symbol, newValue: any, receiver: any): boolean {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new CommunicationError(`Unhandled : ${String(p)}`)
            }

            if (newValue === undefined && sessionPrototype[p] !== undefined) { // Setting a value that exists on the prototype to undefined ?
                throw new CommunicationError(`Cannot set session.${p} to undefined. Please set it to null instead.`) // We can't allow that because the next get would return the initial value (from the prototype) and that's not an expected behaviour.
            }

            target[p] = newValue;

            return true;
        },
        deleteProperty(target: Record<string, any>, p: string | symbol): boolean {
            throw new Error("deleteProperty not implemented.");
        },
        has(target: Record<string, any>, p: string | symbol): boolean {
            throw new Error("has (property) not implemented.");
        },
        ownKeys(target: Record<string, any>): ArrayLike<string | symbol> {
            throw new Error("ownKeys not implemented.");
        }

    });
}

/**
 *
 * @param contentType I.e. text/plain;charset=UTF-8
 * @return Would result into ["text/plain", {charset: "UTF-8"}]
 */
export function parseContentTypeHeader(contentType?: string): [string | undefined, Record<string, string>] {
    const attributes: Record<string, string> = {};

    if (!contentType) {
        return [undefined, attributes];
    }
    const tokens = contentType.split(";");
    for (const token of tokens.slice(1)) {
        if (!token || token.trim() == "") {
            continue;
        }
        if (token.indexOf("=") > -1) {
            const [key, value] = token.split("=");
            if (key) {
                attributes[key.trim()] = value?.trim();
            }
        }
    }

    return [tokens[0], attributes]
}

/**
 * Fixes the encoding to a value, compatible with Buffer
 * @param encoding
 */
export function fixTextEncoding(encoding: string): BufferEncoding {
    const encodingsMap: Record<string, BufferEncoding> = {
        "us-ascii": 'ascii',
        'ascii': "ascii",
        'utf8': 'utf8',
        'utf-8': 'utf-8',
        'utf16le': 'utf16le',
        'ucs2': 'ucs2',
        'ucs-2': 'ucs2',
        'base64': 'base64',
        'base64url': 'base64url',
        'latin1': 'latin1',
    };
    const result = encodingsMap[encoding.toLowerCase()];

    if (!result) {
        throw new CommunicationError(`Invalid encoding: '${encoding}'. Valid encodings are: ${Object.keys(encodingsMap).join(",")}`)
    }

    return result;
}

const FAST_JSON_DETECTOR_REGEXP = /^([0-9\[{]|-[0-9]|true|false|null)/;

export function diagnosis_looksLikeJSON(value: string) {
    return FAST_JSON_DETECTOR_REGEXP.test(value);
}

export function diagnosis_looksLikeHTML(value: string | unknown) {
    if (typeof value !== "string") {
        return false;
    }
    return value.startsWith("<!DOCTYPE html") || value.startsWith("<html") || value.startsWith("<HTML")
}

/**
 * Return If req might be a [simple](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests) request.
 *
 * Not all headers are checked, so rather returns true / triggers security alarm.
 *
 * @param req
 */
export function couldBeSimpleRequest(req: Request) {
    const [contentType] = parseContentTypeHeader(req.header("Content-Type"));
    return (req.method === "GET" || req.method === "HEAD" || req.method === "POST") &&
        (!contentType || contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data" || contentType === "text/plain") &&
        req.header("IsComplex") !== "true"

}

/**
 *
 * @param req
 * @return proto://host[:port] of the origin
 */
export function getOrigin(req: Request): string | undefined {
    if (req.header("Origin")) {
        return req.header("Origin")
    }

    const referer = req.header("Referer");
    if (referer) {
        const refererUrl = URL.parse(referer);
        if (refererUrl.protocol && refererUrl.host) {
            return refererUrl.protocol + "//" + refererUrl.host;
        }
    }
}

/**
 *
 * @param req
 * @return proto://host[:port] of the destination. Or undefined if not (reliably) determined
 */
export function getDestination(req: Request): string | undefined {
    /**
     * In express 4.x req.host is deprecated but req.hostName only gives the name without the port, so we have to work around as good as we can
     */
    function getHost() {
        // @ts-ignore
        if (!req.app) {
            return undefined;
        }

        if (req.app.enabled('trust proxy')) {
            return undefined; // We can't reliably determine the port
        }

        return req.header('Host');
    }

    const host = getHost();

    if (!req.protocol || !host) {
        return undefined;
    }

    return req.protocol + "://" + host;
}

/**
 * Nonexisting props and methods get copied to the target.
 * @param target
 * @param extension
 */
export function extendPropsAndFunctions(target: { [index: string]: any }, extension: { [index: string]: any }) {
    [...Object.keys(extension), ...Array.from(getAllFunctionNames(extension)) as string[]].map(propName => {
        if (target[propName] === undefined) {
            target[propName] = extension[propName];
        }
    })
}

/**
 *
 * @param obj
 * @returns All method names, including "constructor" and the ones from superclasses and prototypes (i.e. "__defineGetter")
 */
export function getAllFunctionNames(obj: object) {
    const proto = Reflect.getPrototypeOf(obj);
    const result:Set<string | Symbol> = proto?getAllFunctionNames(proto):new Set()

        Reflect.ownKeys(obj).forEach((k) => {
            // @ts-ignore
            if(typeof obj[k] === "function") {
                result.add(k);
            }
        });
    return result;
}

/**
 *
 * @param obj plain object or class instance
 * @returns All regular method names of obj and its inherited methods
 */
export function getMethodNames(obj: object) {
    const proto = Reflect.getPrototypeOf(obj);
    const result:Set<string | Symbol> = (proto && proto !== Object.getPrototypeOf({})) ?getMethodNames(proto):new Set()

    Reflect.ownKeys(obj).forEach((k) => {
        // @ts-ignore
        if(typeof obj[k] === "function") {
            result.add(k);
        }
    });
    return result;
}

export function isTypeInfoAvailable(value: object) {
    const r = reflect(value);

    // *** Some heuristic checks: (the rtti api currently has no really good way to check it)
    // TODO: improve checks for security reasons !

    /*
    if(r.methods.length === 0) {
        return false;
    }
    // Still this check was not enough because we received  the methods of the prototype
    */

    if (r.getProperty("xxyyyyzzzzzdoesntExist") !== undefined) { // non existing property reported as existing ?
        return false;
    }

    return true
}

export function diagnosis_hasDeepNullOrUndefined(obj: any): boolean {
    if (obj === null || obj === undefined) {
        return true;
    }

    if (typeof obj === 'object') {
        for (const key in obj) {
            if (obj.hasOwnProperty(key) && diagnosis_hasDeepNullOrUndefined(obj[key])) {
                return true;
            }
        }
    }

    return false;
}
