import {restfuncsExpress, ServerSession, ServerSessionOptions} from "restfuncs-server";
import {ClientProxy, RestfuncsClient} from "restfuncs-client";
import {develop_resetGlobals} from "restfuncs-server/Server";
import {extendPropsAndFunctions} from "restfuncs-server/Util";

export function resetGlobalState() {
    develop_resetGlobals();
    restfuncsClientCookie = undefined;
}

export const standardOptions = {checkArguments: false, logErrors: false, exposeErrors: true}

export class Service extends ServerSession {
    static options: ServerSessionOptions = standardOptions;

    // Hack: To lazy to mark all methods with @remote()
    protected static getOwnRemoteMethodOptions(methodName: string) {
        return super.getOwnRemoteMethodOptions(methodName) || {}
    }
}

type runClientServerTests_Options = {
    path?: string,
    /**
     * Default: test both, with engine.io sockets and without
     */
    useSocket?: boolean
}

export async function runClientServerTests<Api extends object>(serverAPI: Api, clientTests: (proxy: ClientProxy<Api>) => void, param_testOptions: runClientServerTests_Options = {}) {
    if (param_testOptions.useSocket === undefined) {
        await inner(false); // Without engine.io sockets
        await inner(true); // With engine.io sockets
    } else {
        await inner(param_testOptions.useSocket); // With engine.io sockets
    }

    async function inner(useSockets: boolean) {
        resetGlobalState();

        const testOptions: runClientServerTests_Options = {
            path: "/api",
            ...param_testOptions
        }


        const app = restfuncsExpress();
        const service = toServiceClass(serverAPI);
        service.options = {...standardOptions, ...service.options}
        app.use(testOptions.path, service.createExpressHandler());
        const server = app.listen();
        // @ts-ignore
        const serverPort = server.address().port;

        try {
            const client = new RestfuncsClient_fixed<Api & Service>(`http://localhost:${serverPort}${testOptions.path}`, {
                useSocket: useSockets
            });
            try {
                await clientTests(client.proxy);
            } finally {
                await client.close();
            }
        } finally {
            // shut down server
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    }
}

function toServiceClass<Api>(serverAPI: Api): typeof ServerSession {

    if (serverAPI instanceof ServerSession) {
        return serverAPI.clazz;
    } else {
        class ServiceWithTypeInfo extends Service { // Plain ServerSession was not compiled with type info but this file is
        }

        extendPropsAndFunctions(ServiceWithTypeInfo.prototype, serverAPI);

        if (Object.getPrototypeOf(Object.getPrototypeOf(serverAPI))?.constructor) {
            throw new Error("ServerAPI should not be a class without beeing a ServerSession");
        }

        // @ts-ignore
        return ServiceWithTypeInfo;
    }
}

export async function runRawFetchTests<Api extends object>(serverAPI: Api, rawFetchTests: (baseUrl: string) => void, path = "/api", options?: Partial<ServerSessionOptions>) {
    resetGlobalState();

    const app = restfuncsExpress();
    let serviceClass = toServiceClass(serverAPI);
    serviceClass.options = {checkArguments: false, logErrors: false, exposeErrors: true, ...serviceClass.options} // Not the clean way. It should all go through the constructor. TODO: improve it for all the callers
    app.use(path, serviceClass.createExpressHandler());
    const server = app.listen();
    // @ts-ignore
    const serverPort = server.address().port;

    try {
        await rawFetchTests(`http://localhost:${serverPort}${path}`);
    } finally {
        // shut down server
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

export function createServer(serviceClass: typeof Service) {
    const app = restfuncsExpress();

    app.use("/", serviceClass.createExpressHandler());
    return app.listen(0);
}

/**
 * Cookie that's used by restfuncsClient_fixed.
 */
let restfuncsClientCookie: string;

/**
 * Implements a cookie, cause the current nodejs implementations lacks of support for it.
 */
export class RestfuncsClient_fixed<S extends Service> extends RestfuncsClient<S> {
    async httpFetch(url: string, request: RequestInit) {
        const result = await super.httpFetch(url, {
            ...request,
            headers: {...(request.headers || {}), "Cookie": restfuncsClientCookie}
        });
        const setCookie = result.headers.get("Set-Cookie");
        if (setCookie) {
            restfuncsClientCookie = setCookie;
        }
        return result;
    }
}

export async function expectAsyncFunctionToThrow(f: ((...any) => any) | Promise<any>, expected?: string | RegExp | Error | jest.Constructable) {
    let caught = null;
    try {
        if (typeof f === "function") {
            await f();
        } else {
            await f;
        }
    } catch (e) {
        caught = e;
    }

    expect(() => {
        if (caught) {
            throw caught;
        }
    }).toThrow(expected);
}