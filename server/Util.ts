export function isError(e: any) {
    return e !== null && typeof e === "object" && !e.hasOwnProperty("name") && e.name === "Error" && e.message;
}

/**
 * Enhances the funcs object with enhancementProps temporarily with a proxy during the call of callTheFunc
 *
 * The proxy is used to prevent resource conflicts with other (callThe-)funcs. Note that callTheFunc runs asyncronously, so in theory at the same time / overlapping with other funcs.
 * This way, only code inside callTheFunc can access the enhancementProps.
 * @param funcs
 * @param enhancementProps These properties are virtually applied to the funcs object
 * @param callTheFunc
 */
export async function enhanceViaProxyDuringCall<F extends Record<string, any>>(funcs: F, enhancementProps: F, callTheFunc: (funcsProxy: F) => any, diagnosis_funcName: string) {
    // Create a proxy:
    let callHasEnded = false;
    const funcsProxy = new Proxy(funcs, {
        get(target: F, p: string | symbol, receiver: any): any {

            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new Error(`Unhandled : ${String(p)}`);
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