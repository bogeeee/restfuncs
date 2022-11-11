import _ from "underscore"

/**
 * A method that's called here get's send as a REST call to the server.
 * @see createRESTFuncsClient
 */
export class RESTFuncsClient {
    readonly [index: string]: any;

    /**
     * Base url (relative to the current url in the browser)
     */
    public url!: string;
    public method = "POST";

    public async calleRemoteMethod(methodName: string, args: any[]) {

        let requestUrl: string;
        if(this.url) {
            requestUrl = new URL(methodName, this.url + (this.url.endsWith("/")?"":"/")).toString();
        }
        else {
            requestUrl=methodName;
        }



        // Do http request:
        let response;
        try {
            response = await fetch(requestUrl, {
                method: this.method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(args),
                redirect: "follow",
                credentials: "include"
            });
        }
        catch(e) {
            // @ts-ignore
            if(e?.cause) {
                // TODO: throw a better message than just "fetch failed"
            }
            throw e;
        }

        // Error handling:
        if(response.status !== 200) {
            const responseText = await response.text();
            try {
                const responseJSON = JSON.parse(responseText);
                throw new Error(`Server error: ${responseJSON.message || responseJSON}` + (responseJSON.stack?`\nServer stack:${responseJSON.stack}`:''));
            }
            catch (e) { // Error parsing as json ?
                throw new Error(`Server error: ${responseText}`);
            }
        }

        // Parse result:
        return JSON.parse(await response.text()); // Note: await response.json() makes some strange things with {} objects so strict comparision fails in tests

    }

    /**
     *
     * @param props see the public fields (of this class)
     */
    constructor(props: Partial<RESTFuncsClient>) {
        _.extend(this, props); // just copy all given props to this instance (effortless constructor)

        // Create the proxy that translates this.myMethod(..args) into this.remoteMethodCall("myMethod", args)
        return new Proxy(this, {
            get(target: RESTFuncsClient, p: string | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if(typeof p != "string") {
                    throw new Error(`Unhandled : ${String(p)}` );
                }

                // Handle normal property access:
                if(target[p] !== undefined) {
                    return target[p];
                }

                // Handle the rest: p is the name of the remote method
                return function(...args: any) { return target.calleRemoteMethod(p, args)}
            }
        });
    }
}

/**
 * Convenience. see readme.md
 */
export function createRESTFuncsClient<Funcs>(url: string): Funcs {
    // @ts-ignore
    return new RESTFuncsClient({url: url});
}

