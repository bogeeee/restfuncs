import _ from "underscore"

/**
 * Fetch but with a better errormessage
 * @param request
 */
async function fixed_fetch(url: string, request: RequestInit): Promise<any> {
    let response;
    try {
        return await fetch(url, request);
    } catch (e) {
        // @ts-ignore
        if (e?.cause) {
            // TODO: throw a better message than just "fetch failed"
        }
        throw e;
    }
}

/**
 * A method that's called here get's send as a REST call to the server.
 * @see restClient
 */
export class RESTClient {
    readonly [index: string]: any;

    /**
     * Base url (relative to the current url in the browser)
     */
    public url!: string;

    /**
     * HTTP Method for sending all requests
     */
    public method = "POST";

    /**
     * Outermost method. You can override it in a subclass or you may better use {@see wrapSendToServer} where you have more info available
     * @param funcName
     * @param args
     */
    public async doCall(funcName: string, args: any[]) {

        let requestUrl: string;
        if(this.url) {
            requestUrl = `${this.url}${this.url.endsWith("/")?"":"/"}${funcName}`;
        }
        else {
            requestUrl=funcName;
        }



        // Prepare request:
        const sendPrep: SendPreparation = {
            url: requestUrl,
            funcArgs: args,
            req: {
                method: this.method,
                headers: {
                    'Content-Type': 'application/json',
                },
                redirect: "follow",
                credentials: "include"
            }
        }



        return await this.wrapSendToServer(funcName, sendPrep, async (sendPrep) => { // Allow user to intercept (wrap around) here

            sendPrep.req.body = JSON.stringify(args);

            // Exec fetch:
            const response = <Response> await fixed_fetch(sendPrep.url, sendPrep.req);

            // Error handling:
            if(response.status !== 200) {
                const responseText = await response.text();

                let responseJSON;
                try {
                    responseJSON = JSON.parse(responseText);
                }
                catch (e) { // Error parsing as json ?
                    throw new Error(`Server error: ${responseText}`);
                }

                const formatError = (e: any): string => {
                    if(typeof(e) == "object") {
                        return (e.name ? (e.name + ": ") : "") + (e.message || e) +
                            (e.stack ? `\nServer stack: ${e.stack}` : '') +
                            (e.fileName ? `\nFile: ${e.fileName}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
                            (e.cause ? `\nCause: ${formatError(e.cause)}` : '')
                    }
                    else {
                        return e;
                    }
                }

                throw new Error(`Server error: ${formatError(responseJSON)}`);
            }

            // Parse result:
            const result = JSON.parse(await response.text()); // Note: await response.json() makes some strange things with {} objects so strict comparision fails in tests
            return {result, resp: response};
        });
    }

    /**
     *
     * @param options see the public fields (of this class)
     */
    constructor(options: Partial<RESTClient>) {
        _.extend(this, options); // just copy all given options to this instance (effortless constructor)

        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        return new Proxy(this, {
            get(target: RESTClient, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle normal property access:
                if(target[p] !== undefined) {
                    return target[p];
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return target.doCall(p, args)}
            }
        });
    }

    /**
     * Allows you to intercept calls and i.e. handle errors, check for auth, modify headers, filter args / results, ... whatever you like
     * See source code (or readme.md) for base implementation
     *
     * Called from inside doCall
     *
     * @param funcName name of the js function to be called
     * @param sendPrep All info that's yet collected/prepared like http headers etc. You can modify it.
     * @param sendToServer // Does the actual call
     * @return the actual end result of the call that is returned to the user code
     */
    public async wrapSendToServer(funcName: string, sendPrep: SendPreparation, sendToServer: (callPrep: SendPreparation) => Promise<{result: any, resp: Response}>): Promise<any> {
        const {result, resp} = await sendToServer(sendPrep); // Do the actual send
        return result;
    }
}

/**
 * Everythings that's collected / prepared before the "call" is send to the server
 * For use with {@see RESTClient#wrapSendToServer}.
 */
export type SendPreparation = {
    url: string,

    /**
     * The func arguments, like they are finally received on the (remote-) service.
     */
    funcArgs: any[],

    /**
     * See https://developer.mozilla.org/en-US/docs/Web/API/Request
     */
    req: RequestInit,
}


/**
 * Crates a rest client. For usage: See readme.md
 * @param url
 * @param options {@see RESTClient}
 */
export function restClient<Service>(url: string, options: Partial<RESTClient> = {}): Service {
    // @ts-ignore
    return new RESTClient({url: url, ...options});
}

