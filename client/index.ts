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
export class RestClient {
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
     * Outermost caller method.
     *
     * Override this to intercept calls and handle errors, check for auth, filter args / results, ... whatever you like
     *
     * @see doHttpCall For accessing http specific options, override doHttpCall instead
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
        const req: RequestInit = {
            method: this.method,
            headers: {
                'Content-Type': 'application/json',
            },
            redirect: "follow",
            credentials: "include"
        }

        const r = await this.doHttpCall(funcName, args, requestUrl, req);
        return r.result;
    }


    /**
     * Override this to intercept calls and have access or modify http specific info.
     * Or also handle errors, check for auth, filter args / results, ... whatever you like
     *
     * @param funcName
     * @param args Args of the function. They get serialized to json in the request body
     * @param url
     * @param req The request, already prepared to be sent (without the body yet). You can still modify it. See https://developer.mozilla.org/en-US/docs/Web/API/Request
     */
    public async doHttpCall(funcName: string, args: any[], url: string, req: RequestInit): Promise<{result: any, resp: Response}>{
            req.body = JSON.stringify(args);

            // Exec fetch:
            const response = <Response>await fixed_fetch(url, req);

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

                throw new Error(`Server error: ${formatError(responseJSON)}`);
            }

            // Parse result:
            const result = JSON.parse(await response.text()); // Note: await response.json() makes some strange things with {} objects so strict comparision fails in tests
            return {result, resp: response};
        }

    /**
     *
     * @param options see the public fields (of this class)
     */
    constructor(url: string, options: Partial<RestClient> = {}) {
        this.url = url;
        _.extend(this, options); // just copy all given options to this instance (effortless constructor)

        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        return new Proxy(this, {
            get(target: RestClient, p: string | symbol, receiver: any): any {

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

}


/**
 * Crates a rest client. For usage: See readme.md
 * @param url
 * @param options {@see RestClient}
 */
export function restClient<Service>(url: string, options: Partial<RestClient> = {}): Service {
    return <Service> <any> new RestClient(url, options);
}
