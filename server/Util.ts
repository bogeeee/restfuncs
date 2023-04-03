import escapeHtml from "escape-html";

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

            // Output special diagnosis errormessage in case the user hasn't installed a session handler:
            if(p === "session" && enhancementProps[p] === undefined) {
                throw new Error("No session handler has been installed in express. Please install it using the following code snippet:\n" +
                    "***************\n" +
                    "import session from \"express-session\";\n" +
                    "import crypto from \"node:crypto\";\n" +
                    "...\n" +
                    "// Install session handler:\n" +
                    "app.use(session({\n" +
                    "    secret: crypto.randomBytes(32).toString(\"hex\"),\n" +
                    "    cookie: {sameSite: true},\n" +
                    "    saveUninitialized: false, // Only send a cookie when really needed\n" +
                    "    unset: \"destroy\",\n" +
                    "    store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session\n" +
                    "}));\n" +
                    "***************\n");
            }

            // get a property that should be enhanced ?
            if (enhancementProps[p] !== undefined) {
                if (callHasEnded) {
                    throw new Error(`Cannot access .${p} after the call to ${diagnosis_funcName}(...) has ended.`);
                }
                return enhancementProps[p];
            }

            if (callHasEnded) {
                throw new Error(`You must not hand out the this object from inside your ${diagnosis_funcName}(...) function. This is because 'this' is only a proxy (to make req, resp, ... available) but it MUST NOT be referenced after the call to prevent resources leaks.`);
            }

            return target[p]; // normal property
        }
    });

    try {
        await callTheFunc(funcsProxy);
    } finally {
        callHasEnded = true;
    }
}

/**
 * Clones an error with hopefully all properties. You can't list / clone them normally.
 * Using https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#instance_properties to guess the properties
 * @param e
 */
export function cloneError(e: any): object {
    return {
        message: e.message,
        name: e.name,
        cause: e.cause instanceof Error?cloneError(e.cause):e.cause,
        fileName: e. fileName,
        lineNumber: e.lineNumber,
        columnNumber: e.columnNumber,
        stack: e.stack,
        ...e // try everything else that's accessible as properties
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

export function errorToHtml(err: Error | any): string {
    if(!err || typeof err !== "object") {
        return escapeHtml(String(err));
    }

    function textToHtml(value: string) {
        return value.split("\n").map(v => escapeHtml(v)).join("<br/>\n");
    }

    const e = <Error & {cause?: Error, fileName?: string, lineNumber?: Number, columnNumber? : Number, stack?: string}> err; // Better type

    let title= (e.name ? `${e.name}: `: "") + (e.message || String(e))

    let stack = e.stack;
    if(stack?.startsWith(title)) {
        stack=stack.substring(title.length);
    }


    return `<b>${textToHtml( title)}</b>"` +
        (stack ? `\n<pre>${escapeHtml(stack)}</pre>` : '') +
        (e.fileName ? `<br/>\nFile: ${escapeHtml(e.fileName)}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
        (e.cause ? `<br/>\nCause:<br/>\n${errorToHtml(e.cause)}` : '')
}

