import {RemoteMethodOptions, restfuncsExpress, ServerSession, ServerSessionOptions} from "restfuncs-server";
import {ClientProxy, RestfuncsClient, develop_resetGlobalState as client_develop_resetGlobalState} from "restfuncs-client";
import {develop_resetGlobals} from "restfuncs-server/Server";
import {extendPropsAndFunctions} from "restfuncs-server/Util";
import session from "express-session";
import express from "express";
import crypto from "node:crypto";
import {ExternalPromise} from 'restfuncs-common'; ExternalPromise.diagnosis_recordCallstacks=true;

export function resetGlobalState() {
    develop_resetGlobals();
    client_develop_resetGlobalState();
}

export const standardOptions = {logErrors: false, exposeErrors: true}

/**
 * Anonymous service class, created with new class extends Service {...}
 */
export class Service extends ServerSession {
    static options: ServerSessionOptions = standardOptions;

    protected static checkIfMethodHasRemoteDecorator() {

    }

    protected static getRemoteMethodOptions(methodName: string) : RemoteMethodOptions {
        return {validateArguments: false, validateResult: false} // Disable everything that needs Typia, because without @remote() decorators there's no restuncs-meta -> no Typia
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

        app.use(testOptions.path || "", service.createExpressHandler());
        const server = app.listen();
        // @ts-ignore
        const serverPort = server.address().port;

        try {
            const client = new RestfuncsClient<Api & Service>(`http://localhost:${serverPort}${testOptions.path}`, {
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
        class AnonymousService extends Service { // Plain ServerSession was not compiled with type info but this file is
            protected static getRemoteMethodOptions(methodName: string) : RemoteMethodOptions {
                return {validateArguments: false, validateResult: false, trimArguments: false, trimResult: false} // Disable everything that needs type inspection because this would fail for an artificially generated class
            }
        }

        // @ts-ignore
        extendPropsAndFunctions(AnonymousService.prototype, serverAPI);

        if (Object.getPrototypeOf(Object.getPrototypeOf(serverAPI))?.constructor) {
            throw new Error("ServerAPI should not be a class without beeing a ServerSession");
        }

        // @ts-ignore
        return AnonymousService;
    }
}

export async function runRawFetchTests<Api extends object>(serverAPI: Api, rawFetchTests: (baseUrl: string) => void, path = "/api", options?: Partial<ServerSessionOptions>) {
    resetGlobalState();

    const app = restfuncsExpress();
    let serviceClass = toServiceClass(serverAPI);
    serviceClass.options = {logErrors: false, exposeErrors: true, ...serviceClass.options} // Not the clean way. It should all go through the constructor. TODO: improve it for all the callers
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

export function createServer(serviceClass: typeof ServerSession, options?: {classicExpress?: boolean, thirdPartySessionHandler?: boolean, lazyCookie?: boolean}) {
    let app
    if(!options?.classicExpress) {
        app = restfuncsExpress({installSessionHandler: !options?.thirdPartySessionHandler});
    }
    else {
        app = express();
    }

    if(options?.thirdPartySessionHandler) {
        // Install session handler:
        app.use(session({
            secret: "abcd",
            cookie: {sameSite: false},
            saveUninitialized: options?.lazyCookie === false,
            unset: "destroy",
            store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
            resave: false
        }));
    }

    app.use("/", serviceClass.createExpressHandler());
    return app.listen(0);
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