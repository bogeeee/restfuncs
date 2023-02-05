import _ from "underscore"

const SUPPORTED_SERVER_PROTOCOL_MAXVERSION = 1

/**
 * Thrown when there was an Error/exception thrown on the server during method call.
 */
export class ServerError extends Error {
    name= "ServerError"
    /**
     * The Error or exception string that was thrown on the server. We can't keep the orginal class hierarchy, so Errors will just become plain objects.
     */
    cause: any
}

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
 * A method that's called here (on .proxy) get's send as a REST call to the server.
 *
 * Usage:
 * const remote = new RestfuncsClient<MyService>(url).proxy
 * await remote.myMethod()
 * @see restfuncsClient
 */
export class RestfuncsClient<Service> {
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
     * The proxy that is handed out, where the calls are made on
     */
    public proxy: Service

    private async outer_doCall(funcName: string, args: any[]) {
        // Create a simulated environment, to make user's doCall super convenient:
        // Create the proxy that translates this.myMethod(..args) into this.inner_doCall("myMethod", args)
        const userProxy = <Service> <any> new Proxy(this, {
            get(target: RestfuncsClient<any>, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle normal property access:
                if(target[p] !== undefined) {
                    return target[p];
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return target.inner_doCall(p, args)}
            }
        });

        return await this.doCall.apply(userProxy, [funcName, args]);
    }

    /**
     * User's hook
     *
     * Override this to intercept calls and handle errors, check for auth, filter args / results, ... whatever you like
     *
     * For accessing http specific options, override {@see doFetch} instead
     * @param funcName
     * @param args
     */
    public async doCall(funcName:string, args: any[]) {
        return await this[funcName](...args) // Call the original function
    }

    /**
     *
     * @param funcName
     * @param args
     */
    private async inner_doCall(funcName: string, args: any[]) {

        let requestUrl: string;
        if(this.url) {
            requestUrl = `${this.url}${this.url.endsWith("/")?"":"/"}${funcName}`;
        }
        else {
            requestUrl=funcName;
        }

        // Prepare request:
        const req: RequestInit = {
            method: this.method,
            headers: {
                'Content-Type': 'application/json',
            },
            redirect: "follow",
            credentials: "include"
        }

        const r = await this.doFetch(funcName, args, requestUrl, req);
        return r.result;
    }


    /**
     * Override this to intercept calls and have access or modify http specific info.
     *
     * TODO: make it possible to override it via the options
     *
     * @param funcName
     * @param args Args of the function. They get serialized to json in the request body
     * @param url
     * @param req The request, already prepared to be sent (without the body yet). You can still modify it. See https://developer.mozilla.org/en-US/docs/Web/API/Request
     */
    protected async doFetch(funcName: string, args: any[], url: string, req: RequestInit): Promise<{result: any, resp: Response}>{
            req.body = JSON.stringify(args);

            // Exec fetch:
            const response = <Response>await fixed_fetch(url, req);

            // Check server protocol version:
            const serverProtocolVersion = response.headers.get("restfuncs-protocol");
            if(serverProtocolVersion) {
                const [majorVersion, featureVersion] = serverProtocolVersion.split(".").map(str => Number(str));
                if(majorVersion > SUPPORTED_SERVER_PROTOCOL_MAXVERSION) {
                    throw new Error(`Restfuncs server uses a newer protocol version: ${serverProtocolVersion}. Please upgrade the 'restfuncs-client' package`)
                }
                if(featureVersion < REQUIRED_SERVER_PROTOCOL_FEATUREVERSION) {
                    throw new Error(`Restfuncs server uses a a too old protocol feature version: ${serverProtocolVersion}. Please upgrade the 'restfuncs' or the 'restfuncs-server' package on the server`)
                }
            }
            else {
                const responseText = await response.text();
                throw new Error(`Invalid response. Seems like '${this.url}' is not served by restfuncs cause there's no 'restfuncs-protocol' header field. Response body:\n${responseText}`);
            }

            // Error handling:
            if (response.status !== 200) {
                const responseText = await response.text();

                let responseJSON;
                try {
                    responseJSON = JSON.parse(responseText);
                } catch (e) { // Error parsing as json ?
                    throw new Error(`Server error: ${responseText}`);
                }

                const formatError = (e: any): string => {
                    if (typeof (e) == "object") {
                        return (e.name ? (e.name + ": ") : "") + (e.message || e) +
                            (e.stack ? `\nServer stack: ${e.stack}` : '') +
                            (e.fileName ? `\nFile: ${e.fileName}` : '') + (e.lineNumber ? `, Line: ${e.lineNumber}` : '') + (e.columnNumber ? `, Column: ${e.columnNumber}` : '') +
                            (e.cause ? `\nCause: ${formatError(e.cause)}` : '')
                    } else {
                        return e;
                    }
                }

                throw new ServerError(formatError(responseJSON), {cause: responseJSON});
            }

            // Parse result:
            const result = JSON.parse(await response.text()); // Note: await response.json() makes some strange things with {} objects so strict comparision fails in tests
            return {result, resp: response};
        }

    /**
     *
     * @param options see the public fields (of this class)
     */
    constructor(url: string, options: Partial<RestfuncsClient<any>> = {}) {
        this.url = url;
        _.extend(this, options); // just copy all given options to this instance (effortless constructor)

        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        this.proxy = <Service> <any> new Proxy(this, {
            get(target: RestfuncsClient<any>, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle normal property access:
                if(target[p] !== undefined) {
                    return target[p];
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return target.outer_doCall(p, args)}
            }
        });
    }

}


/**
 * Crates a rest client.
 *
 * Usage:
 * const remote = new restfuncsClient<MyService>(url)
 * await remote.myMethod()
 *
 * For full usage guide, see readme.md
 *
 *
 * @param url
 * @param options {@see RestfuncsClient}
 */
export function restfuncsClient<RestService>(url: string, options: Partial<RestfuncsClient<any>> = {}): RestService {
    return new RestfuncsClient<RestService>(url, options).proxy;
}

export default restfuncsClient
